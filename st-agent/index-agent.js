import { getContext } from '../../../extensions.js';
import { MODULE, BRIDGE_ID, DEFAULT_SETTINGS, settings, abortController, running, bridgeOnline, generateOverride, messages, currentView, setSettings, setAbortController, setRunning, setBridgeOnline, setMessages, setCurrentView, setGenerateOverride } from './index-state.js';
import { ctx, loadSettings, saveSettings, pingBridge, getProfiles, generateRawFn, getGenerateRaw, serializeHistory, rawGenerate } from './index-boot.js';
import { typewrite, MODEL_FIELD, buildChatPayload, streamChatCompletion } from './index-stream.js';
import { buildSystemPrompt } from './index-prompt.js';
import { parseToolCalls, repairJson, buildCall, extractFinal, sumChars, compactHistory, stepGenerate } from './index-loop.js';
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
    const turnOps = [];      // 本校执行的工具动作，收尾时折成一条摘要
    let finalText = '';
    try {
        while (steps < settings.maxSteps) {
            if (abortController.signal.aborted) { addLog('error', '已停止'); break; }
            steps++;
            updateStatus(`第 ${steps} 步 · 生成中`);

            const draft = addStreamingDraft();
            let generated;
            try {
                generated = await stepGenerate(compactHistory(messages), {
                    onText: text => draft.setText(text),
                    onReasoning: (text, done) => draft.setReasoning(text, done),
                });
            } catch (error) {
                draft.cleanup();
                throw error;
            }
            draft.finish(generated.streamed);
            const reply = generated.text || '';

            const calls = parseToolCalls(reply);
            const final = extractFinal(reply);
            const planMatch = /<plan>([\s\S]*?)<\/plan>/i.exec(reply);

            if (calls.length === 0) {
                const shown = final || reply || '（模型没有输出内容）';
                draft.finalize({ keep: true, text: shown, reasoning: generated.reasoning });
                messages.push({ role: 'assistant', content: reply });
                finalText = shown;
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
                const approved = await askPlan(planMatch[1].trim(), calls);
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

            if (abortController.signal.aborted) break;

            // —— 批次级确认：同一轮的待批准操作合并成一张卡（替代逐条弹窗） ——
            const needConfirm = calls
                .map(call => ({ call, level: riskOf(call) }))
                .filter(({ level }) => {
                    if (settings.approval === 'all') return true;
                    if (settings.approval === 'write') return level >= 2;
                    return level >= 3;
                });

            let batchDecision = 'all';
            if (needConfirm.length === 1) {
                batchDecision = (await askApproval(needConfirm[0].call)) ? 'all' : 'none';
            } else if (needConfirm.length > 1) {
                batchDecision = settings.batchConfirm
                    ? await askApprovalBatch(needConfirm)
                    : (await askApproval(needConfirm[0].call)) ? 'all' : 'none';
            }

            const denied = new Set();
            if (batchDecision === 'none') needConfirm.forEach(({ call }) => denied.add(call));
            if (batchDecision === 'safe') needConfirm.filter(({ level }) => level > 2).forEach(({ call }) => denied.add(call));

            for (const call of calls) {
                if (abortController.signal.aborted) break;
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
                const briefRaw = String(briefArgs(call.name, call.args) || '').replace(/\s+/g, ' ').trim();
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
            if (abortController.signal.aborted) break;
        }
        if (steps >= settings.maxSteps) {
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
            if (finalText) appendTurn('assistant', finalText, 'final');
            if (turnOps.length) appendTurn('assistant', turnOps.slice(0, 40).join('\n'), 'ops');
            flushSessions();
            renderSessionList();
        } catch (error) {
            console.warn('[st-agent] 会话回写失败：', error && error.message);
        }
        setRunning(false);
        setAbortController(null);
        setBusy(false);
        updateStatus('就绪');
    }
}
