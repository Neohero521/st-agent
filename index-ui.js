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
import { createSession, switchSession, deleteSession, renameSession, renderSessionList, sessionDiag } from './index-sessions.js';
import { journalInfo } from './index-persist.js';

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
                        <div class="sta-sub"><span class="sta-dot"></span><span class="sta-status">连接中…</span><span class="sta-ver">v?</span></div>
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
                    <span>常驻指令（每轮都在，始终生效）</span>
                    <textarea class="sta-instr" rows="3" placeholder="例如：写卡一律中文、变量写中文键名、不要用 XML 包裹 MVU 变量、UI 走 Galgame 暗金风"></textarea>
                    <span class="sta-field-tip">放进 system 最前面，比本插件其余风格建议优先。适合放长期习惯，不适合放一次性的任务要求。</span>
                </label>
                <label class="sta-field">
                    <span>单次输出上限（token）</span>
                    <input class="sta-maxtokens" type="number" min="512" max="65536" step="512" />
                    <span class="sta-field-tip">这条上限来自本插件，不是 API 页的 Max Response Length。太小则长回复会被切在半句，被切会自动续写，但一次写完更顺。</span>
                    <span class="sta-chips">
                        <button type="button" class="sta-chip" data-tokens="4096">4k</button>
                        <button type="button" class="sta-chip" data-tokens="8192">8k</button>
                        <button type="button" class="sta-chip" data-tokens="16384">16k</button>
                        <button type="button" class="sta-chip" data-tokens="32768">32k</button>
                    </span>
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
                    <span>读用户预设</span>
                    <input class="sta-use-preset" type="checkbox" />
                </label>
                <label class="sta-field sta-switch">
                    <span>带当前聊天</span>
                    <input class="sta-chat-context" type="checkbox" />
                </label>
                <label class="sta-field">
                    <span>带入最近几条</span>
                    <input class="sta-chat-turns" type="number" min="2" max="40" step="1" />
                    <span class="sta-field-tip">发送任务时，把酒馆里正在进行的对话（最近这么多楼）一起交给 Agent，它才知道现在聊到哪，不用你把前情再说一遍。</span>
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
                <div class="sta-field sta-selfcheck-row">
                    <span>自检</span>
                    <button type="button" class="sta-btn ghost sta-selfcheck-btn">跑一次</button>
                </div>
                <div class="sta-selfcheck-out">点「跑一次」，把下面这行发我就能定位手机端的问题。</div>
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

export function bindPanel(root) {    const panel = root.querySelector('.sta-panel');
    const log = root.querySelector('.sta-log');
    const input = root.querySelector('.sta-input');
    const send = root.querySelector('.sta-send');
    const stop = root.querySelector('.sta-stop');
    const status = root.querySelector('.sta-status');
    const drawer = root.querySelector('.sta-drawer');
    const profileSel = root.querySelector('.sta-profile');
    const maxSteps = root.querySelector('.sta-maxsteps');
    const maxTokens = root.querySelector('.sta-maxtokens');
    const policy = root.querySelector('.sta-approval-policy');
    const streamMode = root.querySelector('.sta-stream-mode');
    const usePreset = root.querySelector('.sta-use-preset');
    const chatContext = root.querySelector('.sta-chat-context');
    const chatTurns = root.querySelector('.sta-chat-turns');
    const planMode = root.querySelector('.sta-plan-mode');
    const batchConfirm = root.querySelector('.sta-batch-confirm');
    const regTools = root.querySelector('.sta-register-tools');
    const sessionsBtn = root.querySelector('.sta-sessions-btn');
    const sessPanel = root.querySelector('.sta-sessions');
    const sessList = root.querySelector('.sta-sessions-list');
    const sessClose = root.querySelector('.sta-sessions-close');
    const newSess = root.querySelector('.sta-new-session');
    const sessCount = root.querySelector('.sta-sessions-count');

    setCurrentView({ root, panel, log, input, send, stop, status, drawer, profileSel, maxSteps, maxTokens, policy, streamMode, planMode, batchConfirm, regTools, usePreset, chatContext, chatTurns, sessionsBtn, sessPanel, sessionsList: sessList, sessClose, newSess, sessCount });

    root.querySelector('.sta-fab').addEventListener('click', () => togglePanel(true));
    root.querySelector('.sta-close').addEventListener('click', () => togglePanel(false));
    root.querySelector('.sta-gear').addEventListener('click', () => {
        sessPanel.hidden = true;
        drawer.hidden = !drawer.hidden;
    });
    root.querySelector('.sta-drawer-close').addEventListener('click', () => { drawer.hidden = true; });

    send.addEventListener('click', submitTask);
    stop.addEventListener('click', () => { updateStatus('正在停止…'); abortController?.abort(); });
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
    const instr = root.querySelector('.sta-instr');
    if (instr) {
        instr.value = String(settings.instructions || '');
        instr.addEventListener('change', () => {
            settings.instructions = instr.value.slice(0, 2000);
            saveSettings();
        });
        instr.addEventListener('input', () => {
            instr.style.height = 'auto';
            instr.style.height = Math.min(instr.scrollHeight, 140) + 'px';
        });
    }
    maxTokens.addEventListener('change', () => {
        settings.maxTokens = Math.min(65536, Math.max(512, Number(maxTokens.value) || 8192));
        saveSettings();
        syncSettingsUI();
    });
    drawer.querySelectorAll('.sta-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            settings.maxTokens = Number(btn.dataset.tokens) || 8192;
            saveSettings();
            syncSettingsUI();
        });
    });
    policy.addEventListener('change', () => { settings.approval = policy.value; saveSettings(); });
    streamMode.addEventListener('change', () => { settings.streamMode = streamMode.value; saveSettings(); });
    usePreset.addEventListener('change', () => { settings.usePreset = usePreset.checked; saveSettings(); });
    chatContext.addEventListener('change', () => { settings.chatContext = chatContext.checked; saveSettings(); });
    chatTurns.addEventListener('change', () => {
        settings.chatContextTurns = Math.min(40, Math.max(2, Number(chatTurns.value) || 8));
        saveSettings();
        syncSettingsUI();
    });
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
        // 跑任务时开新对话会重绘日志区，把挂在上面的批准卡一起冲掉
        if (running) { addLog('error', '任务进行中，先停止再开新对话'); return; }
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
                if (running) { addLog('error', '任务进行中，先停止再删除会话'); return; }
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
        else if (running) addLog('error', '任务进行中，先停止再切换会话（否则待确认的卡会丢）');
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

    // 版本徽标 + 自检：手机端「到底装的是哪一版、记录到底写进去没有」必须一眼可查，
    // 不然只能靠猜——这也是上一轮"改了但手机上没变化"说不清的地方。
    showVersion();
    const scBtn = root.querySelector('.sta-selfcheck-btn');
    const scOut = root.querySelector('.sta-selfcheck-out');
    if (scBtn && scOut) {
        scBtn.addEventListener('click', () => { runSelfCheck(scOut); });
    }
}

/** 从扩展目录读 manifest 的 version，写进标题旁并打一条 console */
export async function showVersion() {
    let ver = '';
    try {
        const url = new URL('manifest.json', import.meta.url).href + '?t=' + Date.now();
        const res = await fetch(url, { cache: 'no-store' });
        if (res.ok) {
            const m = await res.json();
            ver = String(m && m.version || '');
        }
    } catch { /* 读不到就显示 v? */ }
    const el = (currentView && currentView.root ? currentView.root : document).querySelector('.sta-ver');
    if (el) el.textContent = ver ? 'v' + ver : 'v?';
    console.log('[st-agent] version', ver || '(unknown)');
    return ver;
}

function clockOf(ts) {
    const n = Number(ts) || 0;
    if (!n) return '—';
    const d = new Date(n);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/**
 * 当前这份代码到底是从哪个目录加载的。
 * 酒馆有两个第三方扩展目录：用户目录 data/<handle>/extensions/<名>（显示为 "名"），
 * 以及全局目录 public/scripts/extensions/third-party/<名>（显示为 "third-party/名"）。
 * 两处各放一份时，页面加载的可能不是你刚覆盖的那份——「改了但一直是旧版」多半就在这里。
 */
export function selfPath() {
    try {
        const u = new URL(import.meta.url);
        const seg = u.pathname.split('/');
        const i = seg.indexOf('extensions');
        if (i >= 0) return seg.slice(i + 1).join('/');
        return u.pathname;
    } catch { return ''; }
}

/**
 * 自检：一行字把「版本 / 会话与条目 / 副本有没有在写 / 角色卡与世界书到底刷出来没有」摆清楚。
 * 手机端出问题时让用户念这一行，比来回猜十轮都快。
 */
export async function runSelfCheck(outEl) {
    const box = outEl || (currentView && currentView.root ? currentView.root.querySelector('.sta-selfcheck-out') : null);
    const parts = [];
    try {
        const ver = await showVersion();
        parts.push(ver ? 'v' + ver : 'v?');
    } catch { parts.push('v?'); }

    try {
        const d = sessionDiag();
        parts.push(`会话${d.sessions}/条目${d.msgs}`);
        if (d.recovered) parts.push(`启动回补${d.recovered}`);
    } catch (e) { parts.push('会话读取失败'); }

    try {
        const j = journalInfo();
        parts.push(j.exists ? `副本${j.sessions}个@${clockOf(j.savedAt)}${j.metaOnly ? '(仅目录)' : ''}` : '副本无');
    } catch { parts.push('副本读失败'); }

    try {
        const rows = document.querySelectorAll('#rm_print_characters_block .character_select').length;
        const books = document.querySelectorAll('#world_info option').length;
        const c = ctx();
        const chars = Array.isArray(c && c.characters) ? c.characters.length : -1;
        parts.push(`角色卡${rows}行/数据${chars}`);
        parts.push(`世界书${books > 0 ? books - 1 : 0}本`);
    } catch { parts.push('界面计数失败'); }

    try {
        const w = window;
        parts.push(`屏${w.innerWidth}x${w.innerHeight}`);
        if (w.matchMedia && w.matchMedia('(pointer: coarse)').matches) parts.push('触屏');
    } catch { /* ignore */ }

    try {
        const p = selfPath();
        if (p) parts.push(`路径 ${p.split('/').slice(0, -1).join('/') || p}`);
    } catch { /* ignore */ }

    const line = parts.join(' · ');
    if (box) box.textContent = line;
    console.log('[st-agent] selfcheck:', line);
    return line;
}
