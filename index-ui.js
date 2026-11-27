import { getContext } from '../../../extensions.js';
import { MODULE, BRIDGE_ID, DEFAULT_SETTINGS, settings, abortController, running, bridgeOnline, generateOverride, messages, currentView, setSettings, setAbortController, setRunning, setBridgeOnline, setMessages, setCurrentView, setGenerateOverride } from './index-state.js';
import { ctx, loadSettings, saveSettings, pingBridge, getProfiles, generateRawFn, getGenerateRaw, serializeHistory, rawGenerate } from './index-boot.js';
import { typewrite, MODEL_FIELD, buildChatPayload, streamChatCompletion } from './index-stream.js';
import { buildSystemPrompt } from './index-prompt.js';
import { parseToolCalls, repairJson, buildCall, extractFinal, sumChars, compactHistory, stepGenerate } from './index-loop.js';
import { HIGH_RISK_PATTERNS, RISK_META, riskOf, batchLines, executeTool, summarizeArgs, briefArgs } from './index-risk.js';
import { runAgent } from './index-agent.js';
import { buildMenuEntry, togglePanel, setBusy, updateStatus, addLog, addStreamingDraft } from './index-ui2.js';
import { askPlan, askApprovalBatch, askApproval, submitTask, populateProfiles, syncSettingsUI } from './index-ui3.js';
import { registerChatTools } from './index-tools.js';
import { refreshBridgeState, initialize } from './index.js';

/* ------------------------------ UI ------------------------------ */

export function html(strings, ...values) {
    return strings.reduce((out, s, i) => out + s + (values[i] ?? ''), '');
}

export function buildPanel() {
    const root = document.createElement('div');
    root.className = 'sta-root';
    root.innerHTML = html`
        <button class="sta-fab" title="ST Agent">
            <span class="sta-fab-dot"></span>
            <span class="sta-fab-text">Agent</span>
        </button>
        <section class="sta-panel" aria-hidden="true">
            <header class="sta-header">
                <div class="sta-brand">
                    <div class="sta-logo">SA</div>
                    <div>
                        <div class="sta-title">ST Agent</div>
                        <div class="sta-sub"><span class="sta-dot"></span><span class="sta-status">连接中…</span></div>
                    </div>
                </div>
                <div class="sta-head-actions">
                    <button class="sta-icon-btn sta-gear" title="设置">⚙</button>
                    <button class="sta-icon-btn sta-close" title="关闭">✕</button>
                </div>
            </header>
            <div class="sta-log" role="log"></div>
            <div class="sta-approval" hidden>
                <div class="sta-approval-text"></div>
                <div class="sta-approval-actions">
                    <button class="sta-btn ghost sta-deny">否</button>
                    <button class="sta-btn primary sta-allow">允许</button>
                </div>
            </div>
            <div class="sta-composer">
                <textarea class="sta-input" rows="1" placeholder="交代任务，Shift+Enter 换行"></textarea>
                <div class="sta-composer-actions">
                    <button class="sta-btn ghost sta-stop" hidden>停止</button>
                    <button class="sta-btn primary sta-send">执行</button>
                </div>
            </div>
            <div class="sta-drawer" hidden>
                <div class="sta-drawer-head">
                    <span>设置</span>
                    <button class="sta-icon-btn sta-drawer-close">✕</button>
                </div>
                <label class="sta-field">
                    <span>模型来源</span>
                    <select class="sta-profile"></select>
                </label>
                <label class="sta-field">
                    <span>最大步数</span>
                    <input class="sta-maxsteps" type="number" min="1" max="100" />
                </label>
                <label class="sta-field">
                    <span>审批策略</span>
                    <select class="sta-approval-policy">
                        <option value="auto">仅高危操作确认</option>
                        <option value="write">写操作都确认</option>
                        <option value="all">每步都确认</option>
                    </select>
                </label>
                <label class="sta-field">
                    <span>流式</span>
                    <select class="sta-stream-mode">
                        <option value="auto">自动（chat completion 逐字输出）</option>
                        <option value="off">关闭（全文 + 打字机补放）</option>
                    </select>
                </label>
                <label class="sta-field sta-switch">
                    <span>计划先批准</span>
                    <input class="sta-plan-mode" type="checkbox" />
                </label>
                <label class="sta-field sta-switch">
                    <span>批次确认</span>
                    <input class="sta-batch-confirm" type="checkbox" />
                </label>
                <label class="sta-field sta-switch">
                    <span>聊天内注册工具</span>
                    <input class="sta-register-tools" type="checkbox" />
                </label>
                <div class="sta-hint">模型：默认用酒馆「API 连接」里的当前配置，不需要另建连接。<br>能力：<span class="sta-bridge-state">检测中…</span></div>
            </div>
        </section>
    `;
    document.body.appendChild(root);
    bindPanel(root);
    return root;
}

export function bindPanel(root) {
    const panel = $('.sta-panel', root);
    const log = $('.sta-log', root);
    const input = $('.sta-input', root);
    const send = $('.sta-send', root);
    const stop = $('.sta-stop', root);
    const status = $('.sta-status', root);
    const drawer = $('.sta-drawer', root);
    const profileSel = $('.sta-profile', root);
    const maxSteps = $('.sta-maxsteps', root);
    const policy = $('.sta-approval-policy', root);
    const streamMode = $('.sta-stream-mode', root);
    const planMode = $('.sta-plan-mode', root);
    const batchConfirm = $('.sta-batch-confirm', root);
    const regTools = $('.sta-register-tools', root);

    setCurrentView({ root, panel, log, input, send, stop, status, drawer, profileSel, maxSteps, policy, streamMode, planMode, batchConfirm, regTools });

    $('.sta-fab', root).addEventListener('click', () => togglePanel(true));
    $('.sta-close', root).addEventListener('click', () => togglePanel(false));
    $('.sta-gear', root).addEventListener('click', () => { drawer.hidden = !drawer.hidden; });
    $('.sta-drawer-close', root).addEventListener('click', () => { drawer.hidden = true; });

    send.addEventListener('click', submitTask);
    stop.addEventListener('click', () => abortController?.abort());
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submitTask();
        }
    });
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    });
    input.addEventListener('focus', () => root.classList.add('sta-mobile-focus'));

    profileSel.addEventListener('change', () => { settings.profileId = profileSel.value; saveSettings(); });
    maxSteps.addEventListener('change', () => { settings.maxSteps = Math.max(1, Number(maxSteps.value) || 20); saveSettings(); });
    policy.addEventListener('change', () => { settings.approval = policy.value; saveSettings(); });
    streamMode.addEventListener('change', () => { settings.streamMode = streamMode.value; saveSettings(); });
    planMode.addEventListener('change', () => { settings.planMode = planMode.checked; saveSettings(); });
    batchConfirm.addEventListener('change', () => { settings.batchConfirm = batchConfirm.checked; saveSettings(); });
    regTools.addEventListener('change', () => { settings.registerChatTools = regTools.checked; saveSettings(); registerChatTools(); });
}
