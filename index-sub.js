import { streamChatCompletion } from './index-stream.js';
import { parseToolCalls, extractFinal } from './index-loop.js';
import { executeTool, riskOf } from './index-risk.js';
import { activeTools } from './tools.js';
import { settings, generateOverride, uiHooks } from './index-state.js';

/**
 * 子任务（对标 deepseek-harness 的 subagent / spawn-in-process）
 *
 * DSH 的做法：父级调 `subagent` 只拿回 `started subagent <name>`，**不等结果**；
 * 子任务结束后由运行时把「最终回答」当完成通知递回父级；子任务看不到主对话（spawn 语义），
 * 深度上限 1（子任务不能再派子任务），并发上限 8；`subagent` 来源的 Session 调 exit_plan_mode 必然失败，
 * 要求把未决决策写进最终结果。
 *
 * 这套「不等待 + 完成通知」依赖 DSH 自己的并行运行时（多进程 + 事件总线）。我们跑在酒馆前端里，
 * 只有一个生成通道，硬抄并行会互相打断——所以这里照抄语义、换执行方式：
 *   1. 隔离照抄：子任务有自己的一块上下文（独立 messages，不看主对话，不回主对话写日志正文）。
 *   2. 等待换成分档：wait=true（默认）当场跑完把结论当工具结果返回——手机端最稳；
 *      wait=false 立刻返回 `started subagent <name>`，结果落进父会话，模型下次 `sub.result` 取。
 *   3. 通知换成本地落盘：结论写进父会话的一条消息，等于「下一轮就能看见的完成通知」。
 *   4. 深度=1、plan.* 在子任务里禁用（DSH 同款语义），未决决策必须写进结论。
 *   5. 生成串行化（GEN_LOCK）：同一时刻只有一个子任务在请求模型，避免多个请求把 ST 后端打乱。
 */

const MAX_STEPS = 20;
const MAX_TOOL_CHARS = 4000;
const MAX_RESULT_CHARS = 6000;
const MAX_RUNNING = 3;
const SUB_TOOL_DENYLIST = new Set(['sub.spawn', 'sub.continue', 'plan.write', 'plan.submit', 'plan.reset', 'ui.reload']);

const REG = (globalThis.__staSubs = globalThis.__staSubs || new Map());

/** 生成串行化：所有子任务共用一个队列，一次只让一个请求打到模型 */
let GEN_TAIL = Promise.resolve();
function withGenLock(fn) {
    const run = GEN_TAIL.then(fn, fn);
    GEN_TAIL = run.then(() => {}, () => {});
    return run;
}

function nowMs() { return Date.now(); }

function runningCount() {
    let n = 0;
    for (const s of REG.values()) if (s.status === 'running') n++;
    return n;
}

function nextName() {
    for (let i = 1; i < 200; i++) {
        const n = `agent-${i}`;
        if (!REG.has(n)) return n;
    }
    return `agent-${nowMs()}`;
}

function toolBrief() {
    const names = [];
    for (const t of activeTools()) {
        if (!t || !t.name) continue;
        if (SUB_TOOL_DENYLIST.has(t.name)) continue;
        names.push(t.name);
    }
    return names.join('、');
}

function subSystem(sub) {
    return [
        '你是子任务执行者（subagent）。父 agent 把一件事单独交给你，你看不到主对话，也不要假设自己知道主对话里说过什么。',
        '',
        '## 你的活',
        `- 任务：${sub.task}`,
        `- 名称：${sub.name}（父级用这个名字对账）`,
        '',
        '## 硬约束',
        '1. 一鼓作气做完，不要反问、不要等用户点头：信息实在不够，就在结论里写明缺什么、你按什么假设做的。',
        '2. 不能派子任务（深度已到上限），也不能写/提交计划（plan.* 在这里不可用）：任何未决决策都写进结论，交给父级决定。',
        '3. 不要改与任务无关的东西；不要刷新页面（ui.reload 已禁用）。',
        '4. 反复失败就换路子，别用同样的参数重试第三次。',
        '',
        '## 输出协议',
        '- 你的最后一次回复必须是给父级看的结论：先一句结论，再列关键证据（工具回执里的名字/数字/uid），最后列「还没解决的事」。',
        '- 结论控制在 1500 字内；细节不要念回工具原文。',
        '',
        '## 可用工具（只用这些名字）',
        toolBrief(),
    ].join('\n');
}

function pushResult(parentId, sub) {
    // 完成通知的本地等价：写进父会话，下一轮 historyForContext 就能看见
    try {
        const sink = subSink(parentId);
        if (sink) sink(sub);
    } catch (e) { console.warn('[st-agent] 子任务结果落盘失败：', e && e.message); }
}

/** 由 index-sessions 在启动时注入（避免 index-sub ↔ index-sessions 成环） */
let _subSink = null;
export function setSubSink(fn) { _subSink = typeof fn === 'function' ? fn : null; }
function subSink(id) { return _subSink ? (sub) => _subSink(id, sub) : null; }

export function listSubs() {
    return [...REG.values()].map(s => ({
        name: s.name,
        status: s.status,
        depth: s.depth,
        steps: s.steps,
        tools: s.toolsUsed,
        ms: (s.endedAt || nowMs()) - s.startedAt,
        task: s.task.length > 80 ? s.task.slice(0, 80) + '…' : s.task,
        result: s.result ? s.result.slice(0, 160) : '',
        error: s.error || '',
    }));
}

export function getSub(name) { return REG.get(String(name || '')) || null; }

export function cancelSub(name) {
    const s = REG.get(String(name || ''));
    if (!s) return false;
    if (s.status === 'running') {
        s.status = 'cancelled';
        s.endedAt = nowMs();
        try { s.ctl.abort(); } catch { /* 已结束 */ }
        return true;
    }
    return false;
}

async function loop(sub) {
    const messages = sub.messages;
    for (let step = sub.steps + 1; step <= MAX_STEPS; step++) {
        if (sub.status === 'cancelled') return;
        sub.steps = step;

        // 父级若挂了 mockGenerate（自测 / 演示），子任务也跟着走 mock：同一套输出协议，便于端到端验证
        const text = generateOverride
            ? await withGenLock(() => generateOverride(messages))
            : (await withGenLock(() => streamChatCompletion(messages, { signal: sub.ctl.signal }))).text;
        const raw = String(text || '');
        const calls = parseToolCalls(raw);
        const final = extractFinal(raw);

        if (!calls.length) {
            sub.result = String(final || raw).slice(0, MAX_RESULT_CHARS);
            return;
        }

        messages.push({ role: 'assistant', content: raw });
        for (const call of calls) {
            if (sub.status === 'cancelled') return;
            if (SUB_TOOL_DENYLIST.has(call.name)) {
                messages.push({ role: 'user', content: `<tool_result name="${call.name}" ok="false">这个工具在子任务里不可用（深度/职责限制）。把这件事的未决部分写进结论，交给父级。</tool_result>` });
                continue;
            }
            let payload;
            try {
                // 写权限：默认只读。父级在 sub.spawn 里给 allowWrite:true 才算授权（那次调用本身走了批准）
                if (!sub.allowWrite && riskOf(call) >= 2) {
                    payload = JSON.stringify({ ok: false, blocked: true, error: `子任务默认只读：${call.name} 是写类工具，父级没给 allowWrite。把要写的东西记成清单写进结论，由父级来落地。` });
                    sub.toolsUsed++;
                    if (payload.length > MAX_TOOL_CHARS) payload = payload.slice(0, MAX_TOOL_CHARS);
                    messages.push({ role: 'user', content: `<tool_result name="${call.name}">${payload}</tool_result>` });
                    continue;
                }
                const got = await executeTool(call);
                payload = JSON.stringify(got);
                sub.toolsUsed++;
            } catch (e) {
                payload = `Error: ${e && e.message ? e.message : String(e)}`;
            }
            if (payload.length > MAX_TOOL_CHARS) payload = payload.slice(0, MAX_TOOL_CHARS) + `…（已截断，原长 ${payload.length}）`;
            messages.push({ role: 'user', content: `<tool_result name="${call.name}">${payload}</tool_result>` });
        }
        if (final && final.trim()) {
            // 模型自己收了尾：这条 final 已经说清了，直接结束，不再多跑一步
            sub.result = final.trim().slice(0, MAX_RESULT_CHARS);
            return;
        }
    }
    sub.result = (sub.result || '').trim() || `（子任务 ${sub.name} 达到步数上限 ${MAX_STEPS} 步仍未收尾，以下是最后一轮模型输出）\n` + String(sub.messages[sub.messages.length - 1]?.content || '').slice(0, 2000);
}

async function run(sub) {
    sub.status = 'running';
    sub.startedAt = nowMs();
    try {
        if (runningCount() > MAX_RUNNING) throw new Error(`同时最多 ${MAX_RUNNING} 个子任务，先等一个结束`);
        await loop(sub);
        if (sub.status === 'running') sub.status = 'done';
    } catch (e) {
        if (sub.status !== 'cancelled') {
            sub.status = 'failed';
            sub.error = String(e && e.message ? e.message : e);
        }
    } finally {
        sub.endedAt = nowMs();
    try { uiHooks.paintSub?.(); } catch { /* ignore */ }
        if (sub.status === 'done' || sub.status === 'failed') pushResult(sub.parentId, sub);
    }
    return sub;
}

/**
 * 起一个子任务。
 * wait=true：当场跑完，返回结论（工具结果直接可用）。
 * wait=false：立刻返回，结果稍后落在父会话里，用 sub.result 取。
 */
export async function spawnSub({ task, name, parentId, depth = 1, wait = true, resume = null, allowWrite = false }) {
    const text = String(task || '').trim();
    if (!text) throw new Error('task 不能为空：子任务要一段能独立执行的指令');
    if (depth > 1) throw new Error('子任务不能再派子任务（深度上限 1）：把要做的事写进结论交给父级');
    if (runningCount() >= MAX_RUNNING) throw new Error(`同时最多 ${MAX_RUNNING} 个子任务在跑，先用 sub.list 看状态或 sub.cancel 放掉一个`);

    const key = String(name || '').trim() || nextName();
    if (REG.has(key) && REG.get(key).status === 'running') throw new Error(`子任务名 ${key} 已在运行，换一个 name`);
    if (key === 'lead') throw new Error('name 不能叫 lead（父级保留）');

    const sub = {
        name: key,
        task: text,
        parentId: String(parentId || ''),
        depth,
        status: 'running',
        steps: 0,
        toolsUsed: 0,
        result: '',
        error: '',
        startedAt: 0,
        endedAt: 0,
        allowWrite: !!allowWrite,
        ctl: new AbortController(),
        messages: resume && Array.isArray(resume.messages) && resume.messages.length
            ? [...resume.messages, { role: 'user', content: text }]
            : [{ role: 'system', content: subSystem({ name: key, task: text }) }, { role: 'user', content: text }],
    };
    REG.set(key, sub);
    try { uiHooks.paintSub?.(); } catch { /* 无面板时忽略 */ }

    if (wait) {
        await run(sub);
        return { mode: 'waited', sub };
    }
    // 后台跑：完全不阻塞调用方
    run(sub).catch(() => { /* run 内部已兜底 */ });
    return { mode: 'started', sub };
}

/** 续跑：把上一次的完整上下文带上，新指令接着做（DSH 的 resumable subagent 等价物） */
export async function continueSub({ name, instruction, wait = true }) {
    const prev = REG.get(String(name || ''));
    if (!prev) throw new Error(`没有子任务 ${name}`);
    if (prev.status === 'running') throw new Error(`子任务 ${name} 还在跑，先等它结束`);
    const key = prev.name;
    const sub = {
        name: key,
        task: String(instruction || '').trim() || '继续把上次没做完的部分做完',
        parentId: prev.parentId,
        depth: prev.depth,
        status: 'running',
        steps: 0,
        toolsUsed: 0,
        result: '',
        error: '',
        startedAt: 0,
        endedAt: 0,
        allowWrite: !!prev.allowWrite,
        ctl: new AbortController(),
        messages: [...prev.messages, { role: 'user', content: `续跑指令：${instruction || '继续把上次没做完的部分做完'}` }],
    };
    REG.set(key, sub);
    if (wait) {
        await run(sub);
        return { mode: 'waited', sub };
    }
    run(sub).catch(() => {});
    return { mode: 'started', sub };
}

export const SUB_LIMITS = { MAX_STEPS, MAX_RUNNING, MAX_TOOL_CHARS, MAX_RESULT_CHARS };
