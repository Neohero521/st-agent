import { getContext } from '../../../extensions.js';
import { MODULE, BRIDGE_ID, DEFAULT_SETTINGS, settings, abortController, running, bridgeOnline, generateOverride, messages, currentView, setSettings, setAbortController, setRunning, setBridgeOnline, setMessages, setCurrentView, setGenerateOverride } from './index-state.js';
import { ctx, loadSettings, saveSettings, pingBridge, getProfiles, generateRawFn, getGenerateRaw, serializeHistory, rawGenerate } from './index-boot.js';
import { typewrite, MODEL_FIELD, buildChatPayload, streamChatCompletion } from './index-stream.js';
import { buildSystemPrompt } from './index-prompt.js';
import { parseToolCalls, repairJson, buildCall, extractFinal, sumChars, compactHistory, stepGenerate, continueText, detectTruncation, stripToolMarkup } from './index-loop.js';
import { ensureActiveSession, historyForContext, appendTurn, flushSessions, renderSessionList, renderSessionLog, pruneResultText, forceCompact, maybeCompact, pushSpill, setSummarizer, getTodos, COMPACT_INSTRUCTION } from './index-sessions.js';
import { resetRepeat, noteRepeat, toolTimeoutMs, withTimeout } from './index-guard.js';
import { goalShouldContinue, noteGoalRound, getGoal } from './index-goal.js';
import { HIGH_RISK_PATTERNS, RISK_META, riskOf, batchLines, executeTool, summarizeArgs, briefArgs, takeRefreshNote } from './index-risk.js';
import { html, buildPanel, bindPanel } from './index-ui.js';
import { buildMenuEntry, togglePanel, setBusy, updateStatus, addLog, addStreamingDraft } from './index-ui2.js';
import { askPlan, askApprovalBatch, askApproval, submitTask, populateProfiles, syncSettingsUI } from './index-ui3.js';
import { registerChatTools } from './index-tools.js';
import { refreshBridgeState, initialize } from './index.js';

/**
 * 工具条目的落盘负载。
 * 结果只留前 1400 字：重载后还能点开看关键输出，又不会把会话存储撑爆。
 */
function toolMeta(ok, brief, level, payload) {
    try {
        return JSON.stringify({
            ok: !!ok,
            brief: String(brief || '').slice(0, 60),
            level: Number(level) || 1,
            result: String(payload == null ? '' : payload).slice(0, 1400),
        });
    } catch { return ''; }
}

/**
 * 把「时间 + 常驻指令 + 任务清单 + 目标」贴到 system。
 * 前三样分别对应 DSH context 组的 time-context / agent-instructions，
 * 后两样是 todo / goal 两个家族的投影——DSH 里它们只给 UI 看，
 * 这里同时给模型看，否则模型不知道清单剩什么、也不会遵守 goal 的 phase。
 */
function taskStateBlock(session, startedAt = Date.now()) {
    const lines = [];
    // 时间：写卡场景里日期一致性、日志时间、"现在几点"都靠它，不能让模型自己猜
    const now = new Date();
    let stamp;
    try {
        stamp = now.toLocaleString('zh-CN', { hour12: false });
    } catch { stamp = now.toISOString(); }
    const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    lines.push('', '## 现在');
    lines.push(`- 本地时间：${stamp}（${Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时区'}）`);
    lines.push(`- 本次任务已进行 ${elapsed} 秒`);

    const todos = getTodos(session);
    if (todos.length) {
        lines.push('', '## 当前任务清单（todo.write 整表维护）');
        for (const t of todos) {
            const mark = t.status === 'completed' ? '[x]' : (t.status === 'in_progress' ? '[→]' : '[ ]');
            lines.push(`- ${mark} ${t.content}`);
        }
    }
    const goal = getGoal(session);
    if (goal) {
        lines.push('', '## 当前目标（goal）');
        lines.push(`- ${goal.objective}`);
        lines.push(`- phase=${goal.phase}｜第 ${goal.roundsStarted}/${goal.maxGoalRounds} 轮${goal.blocker ? `｜blocker=${goal.blocker.code}${goal.blocker.note ? '（' + goal.blocker.note + '）' : ''}` : ''}`);
    }
    return lines.length ? lines.join('\n') : '';
}

function isTokenLimitError(error) {
    const msg = String(error?.message || error || '');
    return /max_tokens|max_completion_tokens|max output tokens|maximum context|too many tokens|token.{0,12}too.{0,6}large|invalid.{0,12}max.?tokens?/i.test(msg);
}

/**
 * 上下文窗口超限：历史太长，只能缩历史——和「输出上限太大」是两件事，
 * 后者靠降 maxTokens，前者靠压缩检查点。判定放在降档之前，否则会一路降档降到 2048 还是超。
 */
function isContextOverflow(error) {
    const msg = String(error?.message || error || '');
    if (/max_tokens|max_completion_tokens|max output tokens|invalid.{0,12}max.?tokens?/i.test(msg)) return false;
    return /maximum context|context[ _-]?(length|window)|prompt is too long|input is too long|too many tokens|reduce the length|exceed.{0,20}(context|window)|超出.{0,10}(上下文|窗口)|上下文.{0,10}(超|上限)/i.test(msg);
}

export async function runAgent(task) {
    if (running) return;
    setRunning(true);
    setAbortController(new AbortController());
    setBusy(true);

    // 新的一轮用户消息：重复调用计数清零（跟 DSH 一样，全新指令绝不算循环）
    resetRepeat();
    // 摘要请求接上模型：压缩时先落本地检查点，再让模型照八段结构写一份更好的替换掉
    setSummarizer(async dialog => {
        const { text } = await streamChatCompletion([
            { role: 'user', content: `${dialog}\n\n---\n${COMPACT_INSTRUCTION}` },
        ], {});
        return text;
    });

    const view = currentView;

    // —— 续接：接着当前会话的历史往下走，而不是每次从零开 ——
    // system 每轮重建（含当前卡 / 世界书 / 工具清单），历史只取对话事实
    const session = ensureActiveSession();

    // 开跑前只在「log 不属于当前会话」时重放（刚刷新过页面 / 刚切换过会话）。
    // 同一会话连续对话一律追加，绝不重绘：重绘会把上一轮的过程日志（工具调用、结果、
    // 思考行）抹成 task/final/ops 三条摘要，用户看到的就是"我一说话，记录就被清空了"。
    if (view.log.dataset.sessId !== session.id || !view.log.querySelector('.sta-log-item')) {
        renderSessionLog(session);
    }

    // 空会话的引导提示只服务于"还没开始"，第一条任务进来就撤掉
    const hint = view.log.querySelector('.sta-hint');
    if (hint) hint.remove();
    addLog('user', task);
    const startedAt = Date.now();

    const history = historyForContext(session);

    const system = await buildSystemPrompt();
    // 常驻指令（DSH agent-instructions 的口径：每轮都在，且放在最前，不会被工具说明挤掉）
    const instr = String(settings.instructions || '').trim();
    const head = instr ? `## 常驻指令（用户设定，始终遵守，优先于本提示其余风格建议）\n${instr}\n\n` : '';
    setMessages([{ role: 'system', content: head + system + taskStateBlock(session, startedAt) }, ...history, { role: 'user', content: task }]);
    appendTurn('user', task, 'task');

    let steps = 0;
    let planRejects = 0;
    let finished = false;   // 正常收尾（模型给了结论）标记：避免和"撞到最大步数"混为一谈
    const turnOps = [];      // 本轮执行的工具动作，收尾时折成一条摘要
    let finalText = '';
    let savedMaxTokens = null;   // 服务端嫌上限太大时只在本次任务里降档，收尾时交还原值
    let overflowRetried = false; // 上下文超限只压一次、只重试一次（deepseek-harness 的 overflow 恢复口径）
    try {
        while (steps < settings.maxSteps) {
            if (abortController?.signal?.aborted) { addLog('error', '已停止'); break; }
            steps++;
            updateStatus(`第 ${steps} 步 · 生成中`);

            // —— 请求前压力检查（DSH compaction-basic 的 pre-step 版）——
            // 超阈值就压成检查点 + 保留最近 12 条，本轮上下文随之重建，不再靠丢消息腾空间
            try {
                if (steps > 1 && await maybeCompact(session)) {
                    const sys = messages[0] && messages[0].role === 'system' ? messages[0] : null;
                    const tail = messages.slice(-12);
                    const cp = session.checkpoint ? [{ role: 'user', content: String(session.checkpoint) }] : [];
                    messages.splice(0, messages.length, ...(sys ? [sys] : []), ...cp, ...tail);
                    addLog('plan', `历史过长：已压成检查点（${session.checkpointBy === 'model' ? '模型摘要' : '本地摘要'}），逐字保留最近 12 条`);
                    appendTurn('assistant', `历史超过阈值，已压成检查点（${session.checkpointBy === 'model' ? '模型摘要' : '本地摘要'}）`, 'plan', '', { flush: false, render: false });
                }
            } catch (error) {
                console.warn('[st-agent] 预压缩失败：', error && error.message);
            }

            const draft = addStreamingDraft();
            let generated;
            let reply = '';
            let continueRounds = 0;
            try {
                generated = await stepGenerate(compactHistory(messages), {
                    onText: text => draft.setText(text),
                    onReasoning: (text, done) => draft.setReasoning(text, done),
                });
                reply = generated.text || '';
                // 撞上输出上限时别把半句话当结论：接着写，直到结构闭合
                if (generated.truncated) {
                    const resumed = await continueText(compactHistory(messages), reply, {
                        onText: text => draft.setText(text),
                        onReasoning: (text, done) => draft.setReasoning(text, done),
                        onNote: note => updateStatus(`第 ${steps} 步 · ${note}`),
                    }, settings.maxTokens);
                    reply = resumed.text;
                    continueRounds = resumed.rounds;
                }
            } catch (error) {
                draft.cleanup();
                // ① 上下文窗口超限：把会话压成检查点、丢掉远端的旧轮次再重试。
                //    这比"降 maxTokens"更对路——超限是历史太长，不是输出太长，降档只会让回复更短还照样超。
                if (!overflowRetried && isContextOverflow(error)) {
                    overflowRetried = true;
                    await forceCompact(session, 6);
                    const sys = messages[0] && messages[0].role === 'system' ? messages[0] : null;
                    const tail = messages.slice(-6);
                    const cp = session.checkpoint ? [{ role: 'user', content: String(session.checkpoint) }] : [];
                    messages.splice(0, messages.length, ...(sys ? [sys] : []), ...cp, ...tail);
                    addLog('error', '提示上下文超限：已把会话压成检查点、只保留最近 6 条，重试这一步');
                    appendTurn('assistant', '上下文超限，已压缩历史后重试', 'error', '', { sessionId: session.id, flush: false, render: false });
                    continue;
                }
                // ② 有的服务端不接受这么大的单次上限，直接 400；降一档再试，别让用户自己去猜
                if (isTokenLimitError(error) && settings.maxTokens > 2048) {
                    const before = settings.maxTokens;
                    // 只在本次任务内降档，不动用户设置：否则任务跑完用户会发现
                    // "我明明设的 8192，怎么变成 2048 了"
                    if (savedMaxTokens === null) savedMaxTokens = before;
                    settings.maxTokens = Math.max(2048, Math.floor(settings.maxTokens / 2));
                    addLog('error', `服务端不接受 ${before} token 的输出上限，本次任务已降到 ${settings.maxTokens} 重试这一步`);
                    appendTurn('assistant', `输出上限临时降档：${before} → ${settings.maxTokens}`, 'error', '', { sessionId: session.id, flush: false, render: false });
                    continue;
                }
                throw error;
            }
            if (continueRounds) {
                addLog('plan', `已自动续写 ${continueRounds} 次，把断开的回复接完整（单次上限 ${settings.maxTokens} token）`);
                appendTurn('assistant', `已自动续写 ${continueRounds} 次（单次上限 ${settings.maxTokens} token）`, 'plan', '', { flush: false, render: false });
            }
            draft.finish(generated.streamed);

            const calls = parseToolCalls(reply);
            const final = extractFinal(reply);
            const planMatch = /<plan>([\s\S]*?)<\/plan>/i.exec(reply);

            if (calls.length === 0) {
                const cleanReply = stripToolMarkup(reply);
                const shown = stripToolMarkup(final) || cleanReply || '（模型没有输出内容）';
                draft.finalize({ keep: true, text: shown, reasoning: generated.reasoning });
                messages.push({ role: 'assistant', content: cleanReply || '（模型没有输出内容）' });
                finished = true;
                finalText = shown;
                // 续写次数用完了还没闭合：说清楚是上限不够，而不是模型不想写了
                if (detectTruncation(reply, settings.maxTokens).truncated) {
                    addLog('error', '回复结尾仍被切断：单次输出上限不够，把设置里的「单次输出上限」调到 16384，或让它分段写');
                    appendTurn('assistant', '回复结尾被切断：单次输出上限不足，建议调高或分段写', 'error', '', { flush: false, render: false });
                }
                break;
            }

            draft.finalize({ keep: false, reasoning: generated.reasoning });
            messages.push({ role: 'assistant', content: reply });

            // —— plan-mode：计划里要动数据就先过用户，批准前一条都不执行 ——
            // 注意 ops.plan 本身是只读预演，但它意味着下一步会 ops.apply，所以也算"写意图"
            const writeCalls = calls.filter(call => riskOf(call) >= 2);
            const planIntent = writeCalls.length > 0
                || calls.some(call => call.name === 'ops.plan' || call.name === 'ops.apply');
            if (planMatch && settings.planMode && planIntent) {
                const approved = await askPlan(planMatch[1].trim(), calls, abortController?.signal);
                if (!approved) {
                    planRejects++;
                    addLog('error', '计划未获批准，本轮没有执行任何操作');
                    appendTurn('assistant', '计划未获批准，本轮没有执行任何操作', 'error', '', { flush: false, render: false });
                    messages.push({
                        role: 'user',
                        content: '<tool_result name="plan" ok="false">用户拒绝了这份计划，本轮没有执行任何操作。请调整方案，或先问用户想怎么改。</tool_result>',
                    });
                    if (planRejects >= 2) {
                        addLog('error', '连续两次计划被拒，先停在这里——把任务拆小或换个方向再试。');
                        break;
                    }
                    continue;
                }
            } else if (planMatch) {
                addLog('plan', planMatch[1].trim());
                appendTurn('assistant', planMatch[1].trim(), 'plan', '', { flush: false, render: false });
            }

            if (abortController?.signal?.aborted) break;

            // —— 批次级确认：同一轮的待批准操作合并成一张卡（替代逐条弹窗） ——
            const needConfirm = calls
                .filter(call => !call.parseError)
                .map(call => ({ call, level: riskOf(call) }))
                .filter(({ level }) => {
                    if (settings.approval === 'all') return true;
                    if (settings.approval === 'write') return level >= 2;
                    return level >= 3;
                });

            let batchDecision = 'all';
            const denyList = [];
            if (needConfirm.length === 1) {
                batchDecision = (await askApproval(needConfirm[0].call, abortController?.signal)) ? 'all' : 'none';
            } else if (needConfirm.length > 1) {
                if (settings.batchConfirm) {
                    batchDecision = await askApprovalBatch(needConfirm, abortController?.signal);
                } else {
                    // 关掉「批次确认」就得一条条问。只拿第一张卡的答复放行全部，
                    // 等于用户没见过的删改被一起执行了。
                    for (const item of needConfirm) {
                        const allow = await askApproval(item.call, abortController?.signal);
                        if (!allow) denyList.push(item.call);
                        if (abortController?.signal?.aborted) break;
                    }
                }
            }

            const denied = new Set(denyList);
            if (batchDecision === 'none') needConfirm.forEach(({ call }) => denied.add(call));
            if (batchDecision === 'safe') needConfirm.filter(({ level }) => level > 2).forEach(({ call }) => denied.add(call));

            for (const call of calls) {
                if (abortController?.signal?.aborted) break;
                // 被截断切坏的参数 JSON：宁可这一条不执行，也不能拿空参数去改用户的卡
                if (call.parseError) {
                    const note = `参数不完整，已跳过：${call.parseError}`;
                    addLog('tool', call.name, note, 'fail', riskOf(call));
                    appendTurn('assistant', call.name, 'tool', toolMeta(false, note, riskOf(call), note), { flush: false, render: false });
                    messages.push({
                        role: 'user',
                        content: `<tool_result name="${call.name}" ok="false">参数 JSON 不全或格式错误（${call.parseError}），这次没有执行。请重新输出这一个工具调用：JSON 必须完整闭合，不要写注释，字符串里不要放裸换行。参数能简则简。</tool_result>`,
                    });
                    continue;
                }
                // 循环卫生：同一工具 + 完全相同的参数连续调用，到 3/5/8 次给一句提醒（只建议不否决）
                const repeatNote = noteRepeat(call.name, call.args);
                if (denied.has(call)) {
                    addLog('tool', call.name, '已被用户拒绝', 'denied', riskOf(call));
                    messages.push({
                        role: 'user',
                        content: `<tool_result name="${call.name}" ok="false">用户拒绝执行该操作。</tool_result>${repeatNote ? `\n${repeatNote}` : ''}`,
                    });
                    continue;
                }

                const level = riskOf(call);
                const entry = addLog('tool', call.name, settings.showToolArgs ? summarizeArgs(call.args) : '', '', level);
                updateStatus(`第 ${steps} 步 · 执行 ${call.name}`);
                let payload;
                let ok = true;
                try {
                    // 只给声明了限时的工具（web.fetch / web.search 30s）设协作式上限，
                    // 到点返回清晰的 TOOL_TIMEOUT 错误，而不是把整个会话拖住
                    const result = await withTimeout(executeTool(call), toolTimeoutMs(call.name), call.name);
                    payload = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                } catch (error) {
                    ok = false;
                    payload = error && error.code === 'TOOL_TIMEOUT' ? error.message : `执行失败：${error.message}`;
                }
                entry.setResult(payload, ok);
                entry.setRefresh(takeRefreshNote());
                // 动作摘要带上关键参数：刷新后光看"char.create"不知道建了哪张卡
                const briefRaw = String(briefArgs(call.name, call.args) || '').replace(/[ \t\r\n]+/g, ' ').trim();
                const briefUsable = briefRaw && briefRaw !== '{}' && briefRaw !== '[]' && briefRaw !== '无参数';
                const briefCut = briefUsable ? `(${briefRaw.slice(0, 40)})` : '';
                turnOps.push(call.name + (ok ? '' : '✗') + briefCut);
                // 动作也落盘：手机切后台被回收、回来重载时，这一行不会变成一条笼统摘要
                appendTurn('assistant', call.name, 'tool', toolMeta(ok, briefUsable ? briefRaw.slice(0, 60) : '', level, payload), { flush: false, render: false });
                // 超预算的结果先落一份会话级 spill，再把修剪版塞回上下文：截断不丢信息，要细节时模型能自己取
                const spillId = pushSpill(session, call.name, payload);
                const spilled = spillId ? `\n（结果过长，已存为 spill #${spillId}（原文 ${String(payload).length} 字）。要看细节用 spill.read 带 id 与 offset 分段取，不要重复调用同一个工具）` : '';
                messages.push({
                    role: 'user',
                    content: `<tool_result name="${call.name}" ok="${ok}">${pruneResultText(payload)}${spilled}</tool_result>${repeatNote ? `\n${repeatNote}` : ''}`,
                });
            }

            if (final) {
                addLog('plan', `阶段性结论：${final}`);
                appendTurn('assistant', `阶段性结论：${final}`, 'plan', '', { flush: false, render: false });
            }
            if (abortController?.signal?.aborted) break;
        }
        if (!finished && steps >= settings.maxSteps) {
            addLog('error', `已达到最大步数 ${settings.maxSteps}，任务可能未完成`);
            appendTurn('assistant', `已达到最大步数 ${settings.maxSteps}，任务可能未完成`, 'error', '', { flush: false, render: false });
        }
    } catch (error) {
        if (!abortController?.signal?.aborted) {
            addLog('error', `运行出错：${error.message}`);
            appendTurn('assistant', `运行出错：${error.message}`, 'error', '', { flush: false, render: false });
        }
    } finally {
        // 回写会话：只存「结论 + 动作摘要」，tool_result 不落库（重放时已失效，还会污染上下文）
        try {
            if (finalText) appendTurn('assistant', finalText, 'final', '', { sessionId: session.id });
            if (turnOps.length) appendTurn('assistant', turnOps.slice(0, 40).join(String.fromCharCode(10)), 'ops', '', { sessionId: session.id });
            flushSessions();
            renderSessionList();
        } catch (error) {
            console.warn('[st-agent] 会话回写失败：', error && error.message);
        }
        // 降档只是本任务的权宜之计，交还用户原本的设置
        if (savedMaxTokens !== null) {
            settings.maxTokens = savedMaxTokens;
            syncSettingsUI();
        }
        // 目标还在 active：这次跑完算用掉一个 Round（上限靠它约束）
        try {
            if (goalShouldContinue(session)) noteGoalRound(session);
        } catch (error) {
            console.warn('[st-agent] 目标 Round 记录失败：', error && error.message);
        }
        setRunning(false);
        setAbortController(null);
        setBusy(false);
        updateStatus('就绪');
    }
}
