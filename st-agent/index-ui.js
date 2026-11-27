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
import { createSession, switchSession, deleteSession, renameSession, renderSessionList } from './index-sessions.js';

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
                    <button class="sta-icon-btn sta-sessions-btn" title="会话列表">☰</button>
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
            <div class="sta-sessions" hidden>
                <div class="sta-sessions-head">
                    <span class="sta-sessions-title">会话</span>
                    <span class="sta-sessions-count"></span>
                    <button class="sta-icon-btn sta-sessions-close" title="收起">✕</button>
                </div>
                <div class="sta-sessions-list" role="list"></div>
                <div class="sta-sessions-foot">
                    <button class="sta-btn primary sta-new-session">＋ 新对话</button>
                </div>
            </div>
        </section>
    `;
    document.body.appendChild(root);
    bindPanel(root);
    return root;
}

export function bindPanel(root) {
    const panel = root.querySelector('.sta-panel');
    const log = root.querySelector('.sta-log');
    const input = root.querySelector('.sta-input');
    const send = root.querySelector('.sta-send');
    const stop = root.querySelector('.sta-stop');
    const status = root.querySelector('.sta-status');
    const drawer = root.querySelector('.sta-drawer');
    const profileSel = root.querySelector('.sta-profile');
    const maxSteps = root.querySelector('.sta-maxsteps');
    const policy = root.querySelector('.sta-approval-policy');
    const streamMode = root.querySelector('.sta-stream-mode');
    const planMode = root.querySelector('.sta-plan-mode');
    const batchConfirm = root.querySelector('.sta-batch-confirm');
    const regTools = root.querySelector('.sta-register-tools');
    const sessionsBtn = root.querySelector('.sta-sessions-btn');
    const sessPanel = root.querySelector('.sta-sessions');
    const sessList = root.querySelector('.sta-sessions-list');
    const sessClose = root.querySelector('.sta-sessions-close');
    const newSess = root.querySelector('.sta-new-session');
    const sessCount = root.querySelector('.sta-sessions-count');

    setCurrentView({ root, panel, log, input, send, stop, status, drawer, profileSel, maxSteps, policy, streamMode, planMode, batchConfirm, regTools, sessionsBtn, sessPanel, sessionsList: sessList, sessClose, newSess, sessCount });

    root.querySelector('.sta-fab').addEventListener('click', () => togglePanel(true));
    root.querySelector('.sta-close').addEventListener('click', () => togglePanel(false));
    root.querySelector('.sta-gear').addEventListener('click', () => {
        sessPanel.hidden = true;
        drawer.hidden = !drawer.hidden;
    });
    root.querySelector('.sta-drawer-close').addEventListener('click', () => { drawer.hidden = true; });

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

    /* ---------- 会话列表 ---------- */

    const openSessions = () => {
        drawer.hidden = true;
        sessPanel.hidden = false;
        renderSessionList();
    };
    const closeSessions = () => { sessPanel.hidden = true; };

    sessionsBtn.addEventListener('click', () => { sessPanel.hidden ? openSessions() : closeSessions(); });
    sessClose.addEventListener('click', closeSessions);
    newSess.addEventListener('click', () => {
        createSession();
        closeSessions();
        input.focus();
    });

    // 删除：点一次变「确认？」，3 秒内再点才真删（避免误触）
    let pendingDelete = null;
    const clearPendingDelete = () => {
        if (!pendingDelete) return;
        clearTimeout(pendingDelete.timer);
        const btn = pendingDelete.btn;
        if (btn && btn.isConnected) {
            btn.classList.remove('is-confirm');
            btn.textContent = '✕';
        }
        pendingDelete = null;
    };

    sessList.addEventListener('click', event => {
        const item = event.target.closest('.sta-sess-item');
        if (!item) return;
        const id = item.dataset.id;

        const delBtn = event.target.closest('.sta-sess-del');
        if (delBtn) {
            event.stopPropagation();
            if (pendingDelete && pendingDelete.id === id) {
                clearPendingDelete();
                deleteSession(id);
                return;
            }
            clearPendingDelete();
            delBtn.classList.add('is-confirm');
            delBtn.textContent = '删?';
            pendingDelete = {
                id,
                btn: delBtn,
                timer: setTimeout(() => { clearPendingDelete(); }, 3000),
            };
            return;
        }

        clearPendingDelete();
        if (switchSession(id)) closeSessions();
    });

    // 双击标题就地改名
    sessList.addEventListener('dblclick', event => {
        const titleEl = event.target.closest('.sta-sess-title');
        if (!titleEl) return;
        const item = titleEl.closest('.sta-sess-item');
        const id = item && item.dataset.id;
        if (!id) return;

        const box = document.createElement('input');
        box.className = 'sta-sess-rename';
        box.value = titleEl.textContent;
        titleEl.replaceWith(box);
        box.focus();
        box.select();

        let settled = false;
        const commit = save => {
            if (settled) return;
            settled = true;
            if (save) renameSession(id, box.value);
            renderSessionList();
        };
        box.addEventListener('blur', () => commit(true));
        box.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); commit(true); }
            if (e.key === 'Escape') { e.preventDefault(); commit(false); }
        });
    });
}
