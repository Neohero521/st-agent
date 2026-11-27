import { getContext } from '../../../extensions.js';
import { MODULE, BRIDGE_ID, DEFAULT_SETTINGS, settings, abortController, running, bridgeOnline, generateOverride, messages, currentView, setSettings, setAbortController, setRunning, setBridgeOnline, setMessages, setCurrentView, setGenerateOverride } from './index-state.js';
import { ctx, loadSettings, saveSettings, pingBridge, getProfiles, generateRawFn, getGenerateRaw, serializeHistory, rawGenerate } from './index-boot.js';
import { typewrite, MODEL_FIELD, buildChatPayload, streamChatCompletion } from './index-stream.js';
import { buildSystemPrompt } from './index-prompt.js';
import { parseToolCalls, repairJson, buildCall, extractFinal, sumChars, compactHistory, stepGenerate, continueText, detectTruncation, stripToolMarkup } from './index-loop.js';
import { ensureActiveSession, historyForContext, appendTurn, flushSessions, renderSessionList, renderSessionLog } from './index-sessions.js';
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

function isTokenLimitError(error) {
    const msg = String(error?.message || error || '');
    return /max_tokens|max_completion_tokens|max output tokens|maximum context|too many tokens|token.{0,12}too.{0,6}large|invalid.{0,12}max.?tokens?/i.test(msg);
}

export async function runAgent(task) {
    if (running) return;
    setRunning(true);
    setAbortController(new AbortController());
    setBusy(true);

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

    const history = historyForContext(session);

    const system = await buildSystemPrompt();
    setMessages([{ role: 'system', content: system }, ...history, { role: 'user', content: task }]);
    appendTurn('user', task, 'task');

    let steps = 0;
    let planRejects = 0;
    let finished = false;   // 正常收尾（模型给了结论）标记：避免和"撞到最大步数"混为一谈
    const turnOps = [];      // 本轮执行的工具动作，收尾时折成一条摘要
    let finalText = '';
    let savedMaxTokens = null;   // 服务端嫌上限太大时只在本次任务里降档，收尾时交还原值
    try {
        while (steps < settings.maxSteps) {
            if (abortController?.signal?.aborted) { addLog('error', '已停止'); break; }
            steps++;
            updateStatus(`第 ${steps} 步 · 生成中`);

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
                // 有的服务端不接受这么大的单次上限，直接 400；降一档再试，别让用户自己去猜
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
                if (denied.has(call)) {
                    addLog('tool', call.name, '已被用户拒绝', 'denied', riskOf(call));
                    messages.push({
                        role: 'user',
                        content: `<tool_result name="${call.name}" ok="false">用户拒绝执行该操作。</tool_result>`,
                    });
                    continue;
                }

                const level = riskOf(call);
                const entry = addLog('tool', call.name, settings.showToolArgs ? summarizeArgs(call.args) : '', '', level);
                updateStatus(`第 ${steps} 步 · 执行 ${call.name}`);
                let payload;
                let ok = true;
                try {
                    const result = await executeTool(call);
                    payload = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                } catch (error) {
                    ok = false;
                    payload = `执行失败：${error.message}`;
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
                messages.push({
                    role: 'user',
                    content: `<tool_result name="${call.name}" ok="${ok}">${String(payload).slice(0, 12000)}</tool_result>`,
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
        setRunning(false);
        setAbortController(null);
        setBusy(false);
        updateStatus('就绪');
    }
}
