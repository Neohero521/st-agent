/**
 * 后台作业控制（对标 deepseek-harness packages/jobs/tool-jobs）
 *
 * DSH 的三条语义照抄：
 *   1. 作业属于起它的 agent 会话；一个 agent 看不到别人的作业（我们单会话，天然隔离）。
 *   2. `job.output` 是**消费式**读取：只返回自上次读取以来的增量，末尾永远带 `[status: ...]`。
 *      `wait:true` 等到结算 / 超时为止，超时**不杀**作业，之后的读取还能收走结果。
 *   3. `job.kill` 只是「请求取消」：真正停下才以 cancelled 结算；已结束的返回 already-finished。
 * 本地化：作业只有一种 kind=subagent（我们唯一的后台生产者），id 就是子任务名。
 */

import { getSub, cancelSub } from './index-sub.js';

const DEFAULT_WAIT_MS = 30000;
const MAX_WAIT_MS = 600000;

function reg() {
    return globalThis.__staSubs || new Map();
}

function snapshot(sub) {
    const label = String(sub.task || '').split('\n')[0].slice(0, 120);
    return {
        id: sub.name,
        kind: 'subagent',
        label,
        status: sub.status,
        steps: sub.steps,
        tools: sub.toolsUsed,
        startedAt: sub.startedAt || 0,
        endedAt: sub.endedAt || 0,
        ms: (sub.endedAt || Date.now()) - (sub.startedAt || Date.now()),
        detail: sub.status === 'failed' ? String(sub.error || '').slice(0, 200)
            : sub.status === 'running' ? `${sub.steps} 步 / ${sub.toolsUsed} 次工具`
                : '',
    };
}

export function listJobs() {
    const out = [];
    for (const sub of reg().values()) out.push(snapshot(sub));
    return out.sort((a, b) => a.startedAt - b.startedAt);
}

function formatItems(items) {
    const lines = [];
    for (const it of items) {
        if (it.kind === 'text') lines.push(`[step ${it.step}] ${it.text}`);
        else if (it.kind === 'call') lines.push(`[step ${it.step}] → ${it.name}${it.note ? `（${it.note}）` : ''}`);
        else if (it.kind === 'final') lines.push(`[结论] ${it.text}`);
    }
    return lines.join('\n');
}

/** 消费式取增量：读一次游标就前进，和 DSH 的「流只有一个读取方」一致 */
function takeOutput(sub) {
    const buf = Array.isArray(sub.out) ? sub.out : [];
    const from = Math.max(0, Number(sub.consumed) || 0);
    const items = buf.slice(from);
    sub.consumed = buf.length;
    const body = formatItems(items);
    return body || '(no new output)';
}

function statusLine(sub) {
    const bits = [sub.status];
    if (sub.status === 'running') bits.push(`${sub.steps} 步 / ${sub.toolsUsed} 次工具`);
    if (sub.status === 'failed' && sub.error) bits.push(String(sub.error).slice(0, 200));
    if (sub.status === 'cancelled' && sub.reason) bits.push(`reason: ${sub.reason}`);
    return `[status: ${bits.join('，')}]`;
}

export async function jobOutput({ id, wait, timeout_ms } = {}) {
    const sub = getSub(id);
    if (!sub) throw new Error(`没有 ${id} 这个后台作业（先用 job.list 看有哪些）`);
    if (wait && sub.status === 'running') {
        const ms = Math.min(MAX_WAIT_MS, Math.max(1000, Number(timeout_ms) || DEFAULT_WAIT_MS));
        let timer;
        const timeout = new Promise(resolve => { timer = setTimeout(resolve, ms); });
        const done = sub.promise ? Promise.resolve(sub.promise).catch(() => {}) : timeout;
        await Promise.race([done, timeout]);
        clearTimeout(timer);
    }
    const text = takeOutput(sub);
    const job = snapshot(sub);
    return {
        text: `${text}\n${statusLine(sub)}`,
        job,
        running: sub.status === 'running',
    };
}

export function jobKill({ id, reason } = {}) {
    const sub = getSub(id);
    if (!sub) throw new Error(`没有 ${id} 这个后台作业（先用 job.list 看有哪些）`);
    if (sub.status !== 'running') {
        return { outcome: 'already-finished', job: snapshot(sub) };
    }
    sub.reason = String(reason || '').trim();
    cancelSub(id);
    return { outcome: 'cancellation-requested', job: snapshot(sub) };
}

export const JOB_LIMITS = { DEFAULT_WAIT_MS, MAX_WAIT_MS };
