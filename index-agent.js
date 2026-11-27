import { getContext } from '../../../extensions.js';
import { MODULE, BRIDGE_ID, DEFAULT_SETTINGS, settings, abortController, running, bridgeOnline, generateOverride, messages, currentView, setSettings, setAbortController, setRunning, setBridgeOnline, setMessages, setCurrentView, setGenerateOverride } from './index-state.js';
import { ctx, loadSettings, saveSettings, pingBridge, getProfiles, generateRawFn, getGenerateRaw, serializeHistory, rawGenerate } from './index-boot.js';
import { typewrite, MODEL_FIELD, buildChatPayload, streamChatCompletion } from './index-stream.js';
import { buildSystemPrompt } from './index-prompt.js';
import { parseToolCalls, repairJson, buildCall, extractFinal, sumChars, compactHistory, stepGenerate } from './index-loop.js';
import { HIGH_RISK_PATTERNS, RISK_META, riskOf, batchLines, executeTool, summarizeArgs, briefArgs } from './index-risk.js';
import { html, buildPanel, bindPanel } from './index-ui.js';
import { buildMenuEntry, togglePanel, setBusy, updateStatus, addLog, addStreamingDraft } from './index-ui2.js';
import { askPlan, askApprovalBatch, askApproval, submitTask, populateProfiles, syncSettingsUI } from './index-ui3.js';
import { registerChatTools } from './index-tools.js';
import { refreshBridgeState, initialize } from './index.js';

export async function runAgent(task) {
    if (running) return;
    setRunning(true);
    setAbortController(new AbortController());
    setBusy(true);

    const view = currentView;
    view.log.innerHTML = '';
    addLog('user', task);

    const system = await buildSystemPrompt();
    setMessages([{ role: 'system', content: system }, { role: 'user', content: task }]);

    let steps = 0;
    let planRejects = 0;
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
                draft.finalize({ keep: true, text: final || reply || '（模型没有输出内容）', reasoning: generated.reasoning });
                messages.push({ role: 'assistant', content: reply });
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
                messages.push({
                    role: 'user',
                    content: `<tool_result name="${call.name}" ok="${ok}">${String(payload).slice(0, 12000)}</tool_result>`,
                });
            }

            if (final) addLog('plan', `阶段性结论：${final}`);
            if (abortController.signal.aborted) break;
        }
        if (steps >= settings.maxSteps) addLog('error', `已达到最大步数 ${settings.maxSteps}，任务可能未完成`);
    } catch (error) {
        if (!abortController?.signal?.aborted) addLog('error', `运行出错：${error.message}`);
    } finally {
        setRunning(false);
        setAbortController(null);
        setBusy(false);
        updateStatus('就绪');
    }
}
