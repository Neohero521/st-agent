/**
 * 会话层：多会话存储 + 列表 UI + 历史回放
 *
 * 设计要点（借鉴写卡器 v329.59 的存储经验）：
 *  1. 只持久化「对话事实」（任务 / 最终结论 / 操作摘要），不存 system，不存 tool_result。
 *     system 每轮由 buildSystemPrompt() 重建（含当前卡、世界书、工具清单），存下来换卡就会错。
 *  2. 判定「有没有历史 / 上次是什么」一律查持久化数组，不查内存标志——写卡器 v319.9 踩过这个坑。
 *  3. 容量有二道闸：会话数上限 + 总字符预算。超预算先压缩最旧会话，不静默丢。
 *  4. 存储走 extension_settings（settings.sessions），由酒馆 saveSettingsDebounced 落盘。
 */

import { ctx, saveSettings } from './index-boot.js';
import {
    MODULE, settings, currentView,
    sessions, activeSessionId,
    setSessions, setActiveSessionId,
} from './index-state.js';

const MAX_MSGS_PER_SESSION = 200;   // 单会话最多保留多少条对话事实
const KEEP_ON_COMPACT = 12;         // 压缩时保留的最近条数

let _saveTimer = null;

/* ------------------------------ 基础工具 ------------------------------ */

function newId() {
    return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function nowIso() {
    return Date.now();
}

export function autoTitle(text) {
    const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!t) return '新对话';
    return t.length > 22 ? t.slice(0, 22) + '…' : t;
}

function currentCardName() {
    try {
        const c = ctx();
        const ch = c.characters && c.characters[c.characterId];
        return (ch && (ch.name || ch.avatar)) || '';
    } catch { return ''; }
}

function fmtTime(ts) {
    const d = Number(ts) || 0;
    if (!d) return '';
    const diff = Date.now() - d;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (diff < 864e5) return Math.floor(diff / 3600e3) + ' 小时前';
    if (diff < 1728e5) return '昨天';
    const dt = new Date(d);
    return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function sessionChars(s) {
    if (!s || !Array.isArray(s.messages)) return 0;
    let n = 0;
    for (const m of s.messages) n += String(m && m.content || '').length;
    return n;
}

/* ------------------------------ 装配与持久化 ------------------------------ */

export function initSessions() {
    const raw = Array.isArray(settings.sessions) ? settings.sessions : [];
    // 结构校验 + 清洗：丢掉残破条目，避免后续到处判空
    const cleaned = raw.filter(s => s && typeof s.id === 'string' && Array.isArray(s.messages))
        .map(s => ({
            id: s.id,
            title: typeof s.title === 'string' && s.title.trim() ? s.title : '未命名对话',
            createdAt: Number(s.createdAt) || Number(s.updatedAt) || Date.now(),
            updatedAt: Number(s.updatedAt) || Date.now(),
            cardName: typeof s.cardName === 'string' ? s.cardName : '',
            messages: s.messages
                .filter(m => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
                .map(m => ({ role: m.role, content: m.content, kind: m.kind || (m.role === 'user' ? 'task' : 'final') })),
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);

    setSessions(cleaned);

    const savedActive = typeof settings.activeSessionId === 'string' ? settings.activeSessionId : '';
    const exists = cleaned.some(s => s.id === savedActive);
    setActiveSessionId(exists ? savedActive : (cleaned[0] ? cleaned[0].id : ''));

    renderSessionList();
    renderSessionLog(getActiveSession());
    return cleaned;
}

/**
 * 写入 extension_settings。防抖 300ms，落盘前先 prune。
 * 失败只降级（保留内存态），不阻断用户操作。
 */
export function saveSessions() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        try {
            prune();
            settings.sessions = sessions;
            settings.activeSessionId = activeSessionId;
            saveSettings();
        } catch (error) {
            console.warn('[st-agent] 会话保存失败，先保留内存态：', error && error.message);
        }
    }, 300);
}

/** 立即落盘（页面卸载 / 切换会话前用） */
export function flushSessions() {
    clearTimeout(_saveTimer);
    _saveTimer = null;
    try {
        prune();
        settings.sessions = sessions;
        settings.activeSessionId = activeSessionId;
        saveSettings();
    } catch { /* 卸载路径不抛 */ }
}

/**
 * 二道闸清理：
 *  ① 会话数超上限 → 淘汰最久未使用的（当前会话豁免）
 *  ② 总字符超预算 → 把最旧会话的消息压到最近 KEEP_ON_COMPACT 条
 */
export function prune() {
    const limit = Math.max(1, Number(settings.sessionLimit) || 20);
    if (sessions.length > limit) {
        const sorted = sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt);
        const keep = new Set(sorted.slice(0, limit).map(s => s.id));
        if (activeSessionId) keep.add(activeSessionId);
        const survivors = sessions.filter(s => keep.has(s.id));
        sessions.length = 0;
        survivors.forEach(s => sessions.push(s));
    }

    const budget = Math.max(50000, Number(settings.sessionCharBudget) || 1200000);
    let total = 0;
    for (const s of sessions) total += sessionChars(s);
    if (total <= budget) return;

    const ordered = sessions.slice().sort((a, b) => a.updatedAt - b.updatedAt);
    for (const s of ordered) {
        if (total <= budget) break;
        if (!s.messages.length) continue;
        const before = sessionChars(s);
        s.messages = s.messages.slice(-KEEP_ON_COMPACT);
        s.compacted = true;
        total -= (before - sessionChars(s));
    }

    // 单会话条数上限
    for (const s of sessions) {
        if (s.messages.length > MAX_MSGS_PER_SESSION) s.messages = s.messages.slice(-MAX_MSGS_PER_SESSION);
    }
}

/* ------------------------------ 会话 CRUD ------------------------------ */

export function getSession(id) {
    return sessions.find(s => s.id === id) || null;
}

export function getActiveSession() {
    return getSession(activeSessionId);
}

export function ensureActiveSession() {
    let s = getActiveSession();
    if (s) return s;
    if (sessions.length) {
        setActiveSessionId(sessions[0].id);
        return sessions[0];
    }
    return createSession(undefined, { silent: true });
}

export function createSession(title, opts = {}) {
    const s = {
        id: newId(),
        title: title || '新对话',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        cardName: currentCardName(),
        messages: [],
    };
    sessions.unshift(s);
    setActiveSessionId(s.id);
    flushSessions();
    renderSessionList();
    // silent：Agent 自动开新会话时不要重绘日志区，否则用户会觉得"记录被清空了"
    //         （重绘只服务于"＋ 新对话"按钮，那个场景本来就该看到空白页）
    if (!opts.silent) renderSessionLog(s);
    return s;
}

/**
 * 页面/应用切到后台、关闭时立即落盘。
 * 手机端 webview 被系统回收时 beforeunload 常不触发，必须补 pagehide + visibilitychange。
 */
export function installSessionPersistence() {
    if (installSessionPersistence.bound) return;
    installSessionPersistence.bound = true;
    const flushNow = () => {
        try { flushSessions(); } catch { /* 卸载路径不抛 */ }
    };
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushNow();
    });
}

export function switchSession(id) {
    const s = getSession(id);
    if (!s) return false;
    setActiveSessionId(id);
    s.updatedAt = nowIso();
    saveSessions();
    renderSessionList();
    renderSessionLog(s);
    return true;
}

export function deleteSession(id) {
    const idx = sessions.findIndex(s => s.id === id);
    if (idx < 0) return false;
    sessions.splice(idx, 1);
    if (activeSessionId === id) {
        const next = sessions[idx] || sessions[idx - 1] || sessions[0];
        if (next) {
            setActiveSessionId(next.id);
            renderSessionLog(next);
        } else {
            // 全删光了：开一张新的，不留空壳
            createSession();
            return true;
        }
    }
    saveSessions();
    renderSessionList();
    return true;
}

export function renameSession(id, title) {
    const s = getSession(id);
    if (!s) return false;
    const t = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
    s.title = t || '未命名对话';
    s.updatedAt = nowIso();
    saveSessions();
    renderSessionList();
    return true;
}

/** 追加一条对话事实 */
export function appendTurn(role, content, kind) {
    const s = getActiveSession();
    if (!s) return;
    const text = String(content == null ? '' : content);
    if (!text) return;
    s.messages.push({ role, content: text, kind: kind || (role === 'user' ? 'task' : 'final') });
    if (s.messages.length > MAX_MSGS_PER_SESSION) s.messages = s.messages.slice(-MAX_MSGS_PER_SESSION);
    s.updatedAt = nowIso();
    if (s.title === '新对话' || !s.title) s.title = autoTitle(text);
    if (!s.cardName) s.cardName = currentCardName();
    // 立即落盘：手机端切后台/杀进程时 beforeunload 不一定触发，靠防抖必丢
    flushSessions();
    renderSessionList();
}

/* ------------------------------ 渲染：列表 ------------------------------ */

export function renderSessionList() {
    const host = currentView && currentView.sessionsList;
    if (!host) return;
    host.innerHTML = '';

    if (!sessions.length) {
        const empty = document.createElement('div');
        empty.className = 'sta-sess-empty';
        empty.innerHTML = '<div class="sta-sess-empty-ico">◍</div><div>还没有对话</div><div class="sta-sess-empty-sub">在下面输入任务，会自动开一个</div>';
        host.appendChild(empty);
        if (currentView.sessCount) currentView.sessCount.textContent = '0';
        return;
    }

    const frag = document.createDocumentFragment();
    for (const s of sessions) {
        const item = document.createElement('div');
        item.className = 'sta-sess-item' + (s.id === activeSessionId ? ' is-active' : '');
        item.dataset.id = s.id;

        const dot = document.createElement('span');
        dot.className = 'sta-sess-mark';

        const main = document.createElement('div');
        main.className = 'sta-sess-main';

        const title = document.createElement('div');
        title.className = 'sta-sess-title';
        title.textContent = s.title || '未命名对话';

        const meta = document.createElement('div');
        meta.className = 'sta-sess-meta';
        const parts = [];
        parts.push(`${s.messages.length} 条`);
        parts.push(fmtTime(s.updatedAt));
        if (s.cardName) parts.push(s.cardName);
        if (s.compacted) parts.push('已压缩');
        meta.textContent = parts.join(' · ');

        main.append(title, meta);

        const del = document.createElement('button');
        del.className = 'sta-sess-del';
        del.title = '删除该会话';
        del.textContent = '✕';

        item.append(dot, main, del);
        frag.appendChild(item);
    }
    host.appendChild(frag);
    host.scrollTop = 0;

    // 计数跟着渲染一起更新，不再依赖打开时机
    const countEl = currentView.sessCount;
    if (countEl) countEl.textContent = String(sessions.length);
}

/* ------------------------------ 渲染：历史回放 ------------------------------ */

const TOOL_CALL_RE = /<tool_call(?:\s+name\s*=\s*"[^"]+"\s*>[\s\S]*?<\/tool_call>|\s*>[\s\S]*?<\/tool_call>)/gi;

function stripToolCalls(text) {
    let n = 0;
    const body = String(text || '').replace(TOOL_CALL_RE, () => { n++; return ''; }).trim();
    return { body, calls: n };
}

export function renderSessionLog(session) {
    const view = currentView;
    if (!view || !view.log) return;
    view.log.innerHTML = '';
    const s = session || getActiveSession();
    // 打上"这块 log 属于哪个会话"的标记：runAgent 靠它判断要不要重绘
    view.log.dataset.sessId = s ? s.id : '';
    if (!s || !s.messages.length) {
        const hint = document.createElement('div');
        hint.className = 'sta-log-item sta-hint';
        hint.innerHTML = '<div class="sta-log-head">Agent</div><div class="sta-log-body">新对话。交代任务吧，我会记住这之后的内容。</div>';
        view.log.appendChild(hint);
        return;
    }

    for (const m of s.messages) {
        const entry = document.createElement('div');
        const isUser = m.role === 'user';
        entry.className = 'sta-log-item ' + (isUser ? 'sta-user' : (m.kind === 'ops' ? 'sta-ops-summary' : 'sta-final'));

        const head = document.createElement('div');
        head.className = 'sta-log-head';
        head.textContent = isUser ? '你' : (m.kind === 'ops' ? '动作' : 'Agent');

        const body = document.createElement('div');
        body.className = 'sta-log-body';

        if (isUser) {
            body.textContent = m.content;
        } else if (m.kind === 'ops') {
            // 一轮里可能动了十几样东西：按行拆开一条一行，刷新后仍看得出"这轮到底改了什么"
            const lines = String(m.content || '').split('\n').map(x => x.trim()).filter(Boolean);
            if (lines.length <= 1) {
                body.textContent = lines[0] || '';
            } else {
                body.textContent = '';
                for (const line of lines) {
                    const row = document.createElement('div');
                    row.className = 'sta-ops-line';
                    row.textContent = '· ' + line;
                    body.appendChild(row);
                }
            }
        } else {
            const { body: text, calls } = stripToolCalls(m.content);
            body.textContent = text || `（调用了 ${calls} 个工具）`;
        }

        entry.append(head, body);
        view.log.appendChild(entry);
    }
    view.log.scrollTop = view.log.scrollHeight;
}

/* ------------------------------ 上下文注入 ------------------------------ */

/**
 * 把会话历史转成可注入 messages 的形态。
 * ops 摘要折成一句「上一轮动作」；task/final 原样保留。
 */
export function historyForContext(session) {
    const s = session || getActiveSession();
    if (!s || !s.messages.length) return [];
    return s.messages.map(m => ({
        role: m.role,
        content: m.kind === 'ops'
            ? `（上一轮动作：${m.content}）`
            : m.content,
    }));
}
