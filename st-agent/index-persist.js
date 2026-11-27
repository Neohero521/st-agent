/**
 * localStorage 旁路落盘（v1.13.6）
 *
 * 为什么必须再加一层：
 *   酒馆的 saveSettings() 在 settingsReady=false 时并不写盘，只是「再调度一次」，
 *   而那串 setTimeout 靠的是页面前台还活着。手机端切到后台、webview 被系统回收、
 *   或者刚开机就点进扩展时，定时器根本不会再跑 —— 那个瞬间会话只在内存里，
 *   重进酒馆读回来的就是空的，用户看到的现象就是「我一说句话，之前的记录全没了」。
 *
 * 所以这里用同步的 localStorage 再存一份「日志副本」：
 *   · appendTurn 每次落盘时顺手写一遍（同步 API，不依赖定时器、不会被后台节流）；
 *   · 启动时与后端数据按「谁的消息多就用谁」逐会话合并，后端没写成也不丢；
 *   · 写不下（配额满）就降级只存最近几个会话、再降级只存元信息，绝不抛错打断对话。
 */

const KEY = 'sta_journal_v1';
const KEEP_SESSIONS = 6;      // 旁路只留最近几个会话，够救急又不至于把配额吃满
const KEEP_MSGS = 120;        // 单会话最多留多少条
const MSG_CHARS = 2000;       // 单条最多留多少字符

function nowIso() {
    return Date.now();
}

function clip(text, n) {
    const s = String(text == null ? '' : text);
    return s.length > n ? s.slice(0, n) : s;
}

/** 精简成能塞进 localStorage 的形态 */
function slimSession(s) {
    const msgs = (Array.isArray(s.messages) ? s.messages : [])
        .slice(-KEEP_MSGS)
        .map(m => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: clip(m.content, MSG_CHARS),
            kind: m.kind || '',
            meta: clip(m.meta || '', 400),
        }));
    return {
        id: s.id,
        title: clip(s.title || '', 60),
        createdAt: Number(s.createdAt) || 0,
        updatedAt: Number(s.updatedAt) || 0,
        cardName: clip(s.cardName || '', 80),
        compacted: !!s.compacted,
        messages: msgs,
    };
}

/**
 * 立即写一份副本。失败逐级降级，永远不抛。
 * 返回 { ok, bytes, savedAt, sessions }
 */
export function journalSave(sessions, activeSessionId) {
    const list = Array.isArray(sessions) ? sessions : [];
    if (!list.length) return { ok: false, reason: 'empty', savedAt: 0 };

    const ordered = list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const keep = ordered.slice(0, KEEP_SESSIONS).map(slimSession);
    const payload = { ver: 1, savedAt: nowIso(), activeSessionId: activeSessionId || '', sessions: keep };

    const tryWrite = obj => {
        const text = JSON.stringify(obj);
        window.localStorage.setItem(KEY, text);
        return text.length;
    };

    try {
        const bytes = tryWrite(payload);
        return { ok: true, bytes, savedAt: payload.savedAt, sessions: keep.length };
    } catch (error) {
        // ① 配额满：缩到最近 3 个会话、每会话 60 条、每条 800 字
        try {
            const tiny = {
                ver: 1,
                savedAt: payload.savedAt,
                activeSessionId: payload.activeSessionId,
                sessions: ordered.slice(0, 3).map(s => ({
                    id: s.id,
                    title: clip(s.title || '', 40),
                    createdAt: Number(s.createdAt) || 0,
                    updatedAt: Number(s.updatedAt) || 0,
                    cardName: clip(s.cardName || '', 40),
                    messages: (s.messages || []).slice(-60).map(m => ({
                        role: m.role === 'user' ? 'user' : 'assistant',
                        content: clip(m.content, 800),
                        kind: m.kind || '',
                        meta: '',
                    })),
                })),
            };
            const bytes = tryWrite(tiny);
            return { ok: true, bytes, savedAt: tiny.savedAt, sessions: tiny.sessions.length, degraded: true };
        } catch {
            // ② 还是写不下：只留目录（哪几个会话、各多少条），至少让列表不消失
            try {
                const meta = {
                    ver: 1,
                    savedAt: payload.savedAt,
                    activeSessionId: payload.activeSessionId,
                    metaOnly: true,
                    sessions: ordered.slice(0, 3).map(s => ({
                        id: s.id,
                        title: clip(s.title || '', 40),
                        updatedAt: Number(s.updatedAt) || 0,
                        count: (s.messages || []).length,
                        messages: [],
                    })),
                };
                const bytes = tryWrite(meta);
                return { ok: true, bytes, savedAt: meta.savedAt, sessions: meta.sessions.length, degraded: true, metaOnly: true };
            } catch {
                return { ok: false, reason: String(error && error.message || error), savedAt: 0 };
            }
        }
    }
}

/** 读回副本（损坏就丢弃，不让坏数据把启动带崩） */
export function journalLoad() {
    try {
        const raw = window.localStorage.getItem(KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || !Array.isArray(obj.sessions)) return null;
        return obj;
    } catch {
        return null;
    }
}

export function journalInfo() {
    const j = journalLoad();
    if (!j) return { exists: false };
    let chars = 0;
    for (const s of j.sessions) for (const m of s.messages || []) chars += String(m.content || '').length;
    return {
        exists: true,
        savedAt: Number(j.savedAt) || 0,
        sessions: j.sessions.length,
        chars,
        metaOnly: !!j.metaOnly,
    };
}

export function journalClear() {
    try { window.localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/**
 * 启动时合并：后端存档 + 旁路副本。
 * 规则很简单，也最容易解释给用户：
 *   同一个会话，谁的消息条数多就用谁（后端只写了一半时以副本为准）；
 *   副本里有、后端没有的会话 → 补进列表（说明上次后端没写成）；
 *   后端没有 activeSessionId 时用副本的。
 */
export function journalMerge(backendSessions, backendActiveId) {
    const backend = Array.isArray(backendSessions) ? backendSessions.slice() : [];
    const j = journalLoad();
    if (!j) return { sessions: backend, activeSessionId: backendActiveId || '', recovered: 0, fromJournal: false };

    let recovered = 0;
    const byId = new Map(backend.map(s => [s.id, s]));

    for (const js of j.sessions) {
        if (!js || typeof js.id !== 'string') continue;
        const msgs = (js.messages || []).map(m => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: String(m.content || ''),
            kind: m.kind || (m.role === 'user' ? 'task' : 'final'),
            meta: typeof m.meta === 'string' ? m.meta : '',
        }));
        const exist = byId.get(js.id);
        if (!exist) {
            // 后端整条没了：把副本补回去（只有真有消息的才补，避免凭空造空会话）
            if (msgs.length) {
                const restored = {
                    id: js.id,
                    title: js.title || '未命名对话',
                    createdAt: Number(js.createdAt) || Date.now(),
                    updatedAt: Number(js.updatedAt) || Date.now(),
                    cardName: js.cardName || '',
                    messages: msgs,
                    recovered: true,
                };
                backend.push(restored);
                byId.set(js.id, restored);
                recovered++;
            }
            continue;
        }
        // 两边都有：消息更多的那个更有料（后端在手机上常常只写进了半截）
        if (msgs.length > (exist.messages || []).length) {
            exist.messages = msgs;
            if (!exist.title || exist.title === '新对话') exist.title = js.title || exist.title;
            recovered++;
        }
    }

    const active = (backendActiveId && backend.some(s => s.id === backendActiveId))
        ? backendActiveId
        : (j.activeSessionId && backend.some(s => s.id === j.activeSessionId) ? j.activeSessionId : '');

    return {
        sessions: backend,
        activeSessionId: active,
        recovered,
        fromJournal: true,
        savedAt: Number(j.savedAt) || 0,
    };
}
