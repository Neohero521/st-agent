import { getContext } from '../../../extensions.js';
import { MODULE, BRIDGE_ID, DEFAULT_SETTINGS, settings, abortController, running, bridgeOnline, generateOverride, messages, currentView, setSettings, setAbortController, setRunning, setBridgeOnline, setMessages, setCurrentView, setGenerateOverride } from './index-state.js';
import { ctx, loadSettings, saveSettings, pingBridge, getProfiles, generateRawFn, getGenerateRaw, serializeHistory, rawGenerate } from './index-boot.js';
import { typewrite, MODEL_FIELD, buildChatPayload, streamChatCompletion } from './index-stream.js';
import { buildSystemPrompt } from './index-prompt.js';
import { parseToolCalls, repairJson, buildCall, extractFinal, sumChars, compactHistory, stepGenerate } from './index-loop.js';
import { HIGH_RISK_PATTERNS, RISK_META, riskOf, batchLines, executeTool, summarizeArgs, briefArgs } from './index-risk.js';
import { runAgent } from './index-agent.js';
import { html, buildPanel, bindPanel } from './index-ui.js';
import { buildMenuEntry, togglePanel, setBusy, updateStatus, addLog, addStreamingDraft } from './index-ui2.js';
import { registerChatTools } from './index-tools.js';
import { refreshBridgeState, initialize } from './index.js';

/**
 * 计划卡：模型给了 <plan> 且本轮要写东西时，先把计划和待执行清单摆出来，
 * 用户点「按此执行」才真的往下走（写卡器 plan-mode 的同款语义：未批准不落盘）。
 */
export function askPlan(planText, calls) {
    return new Promise(resolve => {
        const card = document.createElement('div');
        card.className = 'sta-log-item sta-plan-card';
        card.innerHTML = `
            <div class="sta-plan-head"><span class="sta-plan-icon">◇</span><span class="sta-plan-title">执行计划</span></div>
            <div class="sta-plan-body"></div>
            <div class="sta-plan-list"></div>
            <div class="sta-plan-actions">
                <button class="sta-btn ghost sta-plan-no">取消</button>
                <button class="sta-btn primary sta-plan-yes">按此执行</button>
            </div>`;
        card.querySelector('.sta-plan-body').textContent = planText || '（模型没有写计划说明）';

        const list = card.querySelector('.sta-plan-list');
        const pushRow = (toolName, args, label, isSub = false) => {
            const level = riskOf({ name: toolName, args });
            const row = document.createElement('div');
            row.className = `sta-plan-row ${RISK_META[level].cls}${isSub ? ' sta-plan-sub' : ''}`;
            row.innerHTML = '<span class="sta-plan-idx"></span><span class="sta-plan-tool"></span><span class="sta-risk-badge"></span><span class="sta-plan-target"></span>';
            row.querySelector('.sta-plan-idx').textContent = label;
            row.querySelector('.sta-plan-tool').textContent = toolName;
            const badge = row.querySelector('.sta-risk-badge');
            badge.classList.add(RISK_META[level].cls);
            badge.textContent = RISK_META[level].label;
            row.querySelector('.sta-plan-target').textContent = briefArgs(toolName, args);
            list.appendChild(row);
        };
        calls.forEach((call, i) => {
            pushRow(call.name, call.args, `${i + 1}.`);
            // 批处理把明细展开：用户要看到这里面到底动了哪几条
            if ((call.name === 'ops.plan' || call.name === 'ops.apply') && Array.isArray(call.args?.ops)) {
                call.args.ops.forEach(op => {
                    const inner = String(op?.tool || op?.name || '?');
                    pushRow(inner, op?.args || {}, '·', true);
                });
            }
        });

        currentView.log.appendChild(card);
        currentView.log.scrollTop = currentView.log.scrollHeight;

        const done = value => {
            card.querySelectorAll('button').forEach(button => { button.disabled = true; });
            card.classList.add(value ? 'sta-plan-approved' : 'sta-plan-rejected');
            resolve(value);
        };
        card.querySelector('.sta-plan-yes').addEventListener('click', () => done(true));
        card.querySelector('.sta-plan-no').addEventListener('click', () => done(false));
    });
}

/**
 * 批次确认：同一轮多个待批准操作只弹一次卡。
 * 返回 'all' | 'safe' | 'none'（safe = 只放行只读与普通写入，高危项跳过）。
 */
export function askApprovalBatch(entries) {
    return new Promise(resolve => {
        const box = currentView.root.querySelector('.sta-approval');
        box.hidden = false;
        box.classList.add('sta-approval-batch');

        const text = box.querySelector('.sta-approval-text');
        text.innerHTML = '';
        const title = document.createElement('div');
        title.className = 'sta-approval-title';
        title.textContent = `本轮要执行 ${entries.length} 个操作，确认一次后整批放行：`;
        text.appendChild(title);

        const list = document.createElement('div');
        list.className = 'sta-approval-list';
        entries.forEach(({ call, level }, i) => {
            const row = document.createElement('div');
            row.className = `sta-approval-row ${RISK_META[level].cls}`;
            const name = document.createElement('span');
            name.className = 'sta-approval-name';
            name.textContent = `${i + 1}. ${call.name}`;
            const badge = document.createElement('span');
            badge.className = `sta-risk-badge ${RISK_META[level].cls}`;
            badge.textContent = RISK_META[level].label;
            const target = document.createElement('span');
            target.className = 'sta-approval-target';
            target.textContent = summarizeArgs(call.args);
            row.append(name, badge, target);
            list.appendChild(row);
        });
        text.appendChild(list);

        const actions = box.querySelector('.sta-approval-actions');
        let safeButton = box.querySelector('.sta-approval-safe');
        if (!safeButton) {
            safeButton = document.createElement('button');
            safeButton.className = 'sta-btn ghost sta-approval-safe';
            safeButton.textContent = '只执行安全的';
            actions.insertBefore(safeButton, actions.querySelector('.sta-allow'));
        }
        const hasRisky = entries.some(({ level }) => level > 2);
        safeButton.hidden = !hasRisky;

        const allow = box.querySelector('.sta-allow');
        const deny = box.querySelector('.sta-deny');

        const cleanup = value => {
            box.hidden = true;
            box.classList.remove('sta-approval-batch');
            safeButton.remove();
            allow.removeEventListener('click', onAllow);
            deny.removeEventListener('click', onDeny);
            safeButton.removeEventListener('click', onSafe);
            resolve(value);
        };
        const onAllow = () => cleanup('all');
        const onSafe = () => cleanup('safe');
        const onDeny = () => cleanup('none');
        allow.addEventListener('click', onAllow);
        deny.addEventListener('click', onDeny);
        safeButton.addEventListener('click', onSafe);
    });
}

export function askApproval(call) {
    return new Promise(resolve => {
        const box = currentView.root.querySelector('.sta-approval');
        box.hidden = false;
        box.querySelector('.sta-approval-text').textContent = `待批准：${call.name}  ${summarizeArgs(call.args)}`;
        const allow = box.querySelector('.sta-allow');
        const deny = box.querySelector('.sta-deny');
        const cleanup = value => {
            box.hidden = true;
            allow.removeEventListener('click', onAllow);
            deny.removeEventListener('click', onDeny);
            resolve(value);
        };
        const onAllow = () => cleanup(true);
        const onDeny = () => cleanup(false);
        allow.addEventListener('click', onAllow);
        deny.addEventListener('click', onDeny);
    });
}

export function submitTask() {
    if (running) return;
    const text = currentView.input.value.trim();
    if (!text) return;
    currentView.input.value = '';
    currentView.input.style.height = 'auto';
    runAgent(text);
}

export function populateProfiles() {
    if (!currentView) return;
    const list = getProfiles();
    const sel = currentView.profileSel;
    sel.innerHTML = '';
    // 第一项永远是「当前酒馆 API」：直接用「API 连接」里配置的模型与密钥
    const current = document.createElement('option');
    current.value = "";
    const apiLabel = (() => {
        try {
            const oai = ctx().oai_settings || {};
            const model = oai.chat_completion_source === 'openai' ? oai.openai_model : (oai.oai_settings?.custom_model || '酒馆主 API');
            return `当前酒馆 API${model ? '（' + model + '）' : ''}`;
        } catch {
            return '当前酒馆 API';
        }
    })();
    current.textContent = apiLabel;
    sel.appendChild(current);

    for (const p of list) {
        const option = document.createElement('option');
        option.value = p.id;
        option.textContent = `${p.name || p.model || p.id}${p.model ? ' · ' + p.model : ''}`;
        sel.appendChild(option);
    }
    const valid = settings.profileId && list.some(p => p.id === settings.profileId);
    sel.value = valid ? settings.profileId : '';
    settings.profileId = sel.value;
}

export function syncSettingsUI() {
    if (!currentView) return;
    currentView.maxSteps.value = settings.maxSteps;
    currentView.policy.value = settings.approval;
    currentView.streamMode.value = settings.streamMode;
    currentView.planMode.checked = !!settings.planMode;
    currentView.batchConfirm.checked = !!settings.batchConfirm;
    currentView.regTools.checked = !!settings.registerChatTools;
}
