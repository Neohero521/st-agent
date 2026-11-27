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
import { stripToolMarkup } from './index-loop.js';
import { journalSave, journalMerge } from './index-persist.js';
import {
    MODULE, settings, currentView, running,
    sessions, activeSessionId,
    setSessions, setActiveSessionId,
} from './index-state.js';

const MAX_MSGS_PER_SESSION = 200;   // 单会话最多保留多少条对话事实
const KEEP_ON_COMPACT = 12;         // 压缩时逐字保留的最近条数

/**
 * 上下文压力策略（对标 deepseek-harness packages/compaction 的做法）：
 *  · 工具结果修剪：超 8192 码点的结果，保留头 4096 + 尾 1024，中间打标记。
 *    头尾都留是关键——结论、报错、回执通常在末尾，只截前 1400 字会把它们全丢掉。
 *  · 会话检查点：单会话超过 CHECKPOINT_TRIGGER_CHARS 时，把最旧部分压成一条检查点，
 *    近期消息逐字保留，后续请求从检查点继续，而不是把老消息直接扔掉。
 */
const RESULT_PRUNE_CHARS = 8192;
const RESULT_PRUNE_HEAD = 4096;
const RESULT_PRUNE_TAIL = 1024;
const RESULT_PRUNE_MARK = '\n\n[... 结果中段已裁剪 ...]\n\n';
const CHECKPOINT_TRIGGER_CHARS = 80000;

// 会话里允许出现的条目类型：task/final/ops 是上下文事实，tool/plan/error 只用于界面回放
const KINDS = new Set(['task', 'final', 'ops', 'tool', 'plan', 'error']);
// 过程条目带上结果原文（截断），刷新后才能点开看，但长度受控，避免撑爆存储
const RESULT_SNAPSHOT_CHARS = 1400;

const LEVEL_LABEL = { 1: '只读', 2: '写入', 3: '高危' };
const LEVEL_CLS = { 1: 'sta-risk-1', 2: 'sta-risk-2', 3: 'sta-risk-3' };

let _saveTimer = null;
let lastRecovered = 0;          // 上次启动时从 localStorage 副本补回了多少会话/更长的记录
let lastJournalSavedAt = 0;     // 副本最近一次写入时间，自检要显示

/** 同步写一份 localStorage 副本（不依赖定时器，手机切后台也不会被吞） */
function touchJournal() {
    const res = journalSave(sessions, activeSessionId);
    lastJournalSavedAt = res && res.ok ? (res.savedAt || Date.now()) : 0;
    return res;
}

/** 给面板自检用：当前到底存了几条、副本有没有在写 */
export function sessionDiag() {
    let msgs = 0;
    for (const s of sessions) msgs += Array.isArray(s.messages) ? s.messages.length : 0;
    return {
        sessions: sessions.length,
        msgs,
        activeSessionId,
        recovered: lastRecovered,
        journalSavedAt: lastJournalSavedAt,
    };
}

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
    let n = String(s.checkpoint || '').length;
    for (const m of s.messages) n += String(m && m.content || '').length;
    if (Array.isArray(s.spill)) for (const x of s.spill) n += String(x && x.text || '').length;
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
                .map(m => ({
                    role: m.role,
                    content: m.content,
                    kind: KINDS.has(m.kind) ? m.kind : (m.role === 'user' ? 'task' : 'final'),
                    meta: typeof m.meta === 'string' ? m.meta : '',
                })),
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);

    setSessions(cleaned);

    const savedActive = typeof settings.activeSessionId === 'string' ? settings.activeSessionId : '';
    // 后端存档 + localStorage 副本合并：
    // 手机端 saveSettings 被后台挂死时只写了半截甚至没写，副本能把丢的补回来。
    const merged = journalMerge(cleaned, savedActive);
    setSessions(merged.sessions);
    lastRecovered = merged.recovered || 0;
    const activeId = merged.activeSessionId && merged.sessions.some(s => s.id === merged.activeSessionId)
        ? merged.activeSessionId
        : (merged.sessions[0] ? merged.sessions[0].id : '');
    setActiveSessionId(activeId);
    // 合并完立刻回写两边，别让副本继续比后端新
    touchJournal();
    // 副本补回来的内容要马上写进酒馆存档：否则后端一直是空的，每次都只能靠副本救，
    // 用户一旦清了浏览器数据就真没了。settings 还没 ready 时酒馆会自己排一次保存，不阻断启动。
    try {
        settings.sessions = sessions;
        settings.activeSessionId = activeSessionId;
        saveSettings();
    } catch { /* 启动早期保存失败不影响本次使用，副本已写 */ }

    renderSessionList();
    renderSessionLog(getActiveSession());
    return merged.sessions;
}

/**
 * 写入 extension_settings。防抖 300ms，落盘前先 prune。
 * 失败只降级（保留内存态），不阻断用户操作。
 */
export function saveSessions() {
    touchJournal();
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
    touchJournal();
    try {
        prune();
        settings.sessions = sessions;
        settings.activeSessionId = activeSessionId;
        saveSettings();
    } catch { /* 卸载路径不抛 */ }
}

/**
 * 工具结果修剪：超出预算就保留头尾、中间替换成标记。
 * deepseek-harness 的 pruner 用同一套预算（8192 / 4096 / 1024，按 Unicode 码点切，不拆 emoji 对）。
 */
export function pruneResultText(text) {
    const s = String(text == null ? '' : text);
    if (s.length <= RESULT_PRUNE_CHARS) return s;
    const head = Array.from(s).slice(0, RESULT_PRUNE_HEAD).join('');
    const tail = Array.from(s).slice(-RESULT_PRUNE_TAIL).join('');
    return head + RESULT_PRUNE_MARK + tail;
}

/**
 * 会话检查点：把要被压缩掉的旧消息整理成结构化摘要。
 * 纯本地生成、不额外调模型（手机端多一次请求就是几秒等待 + 一份额度），
 * 结构按 deepseek-harness 的 checkpoint 八段裁到与写卡/酒馆任务相关的六段。
 */
function buildCheckpoint(drop) {
    const clip = (v, n) => {
        const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
        return s.length > n ? s.slice(0, n) + '…' : s;
    };
    const tasks = drop.filter(m => m.kind === 'task').map(m => clip(m.content, 160));
    const ops = drop.filter(m => m.kind === 'ops').map(m => clip(m.content, 80));
    const finals = drop.filter(m => m.kind === 'final').map(m => clip(m.content, 200));
    const errors = drop.filter(m => m.kind === 'error').map(m => clip(m.content, 120));
    const tools = [...new Set(drop.filter(m => m.kind === 'tool' && m.tool).map(m => String(m.tool)))];
    const lines = [];
    lines.push('<compacted-summary>');
    lines.push('（这是本会话此前对话的自动检查点，属于既有背景：直接在此基础上继续，不要复述、不要回应这段。）');
    lines.push('');
    lines.push('## 目标');
    if (tasks.length) {
        lines.push('- 最初：' + tasks[0]);
        if (tasks.length > 1) lines.push('- 最近：' + tasks[tasks.length - 1]);
    } else lines.push('- （无明确任务记录）');
    lines.push('## 已执行的操作');
    if (ops.length) for (const o of ops.slice(-10)) lines.push('- ' + o);
    else lines.push('- （无）');
    lines.push('## 已用工具');
    lines.push(tools.length ? '- ' + tools.join('、') : '- （无）');
    if (errors.length) {
        lines.push('## 报错与失败');
        for (const e of errors.slice(-5)) lines.push('- ' + e);
    }
    lines.push('## 已确认的结论');
    if (finals.length) for (const f of finals.slice(-5)) lines.push('- ' + f);
    else lines.push('- （无）');
    lines.push('## 压缩时点');
    lines.push(`- 共压缩 ${drop.length} 条历史；逐字保留最近 ${KEEP_ON_COMPACT} 条`);
    lines.push('</compacted-summary>');
    return lines.join('\n');
}

/** 把一条会话压成「检查点 + 最近 N 条」，返回是否真的压了 */
function compactSession(s, keep = KEEP_ON_COMPACT) {
    if (!Array.isArray(s.messages) || s.messages.length <= keep) return false;
    const drop = s.messages.slice(0, s.messages.length - keep);
    s.checkpoint = buildCheckpoint(drop);
    s.messages = s.messages.slice(-keep);
    s.compacted = true;
    s.compactedAt = nowIso();
    s.compactCount = (Number(s.compactCount) || 0) + 1;
    return true;
}

/** 手动强制压缩（上下文超限重试时用）：逐字只留 keep 条 */
export function forceCompact(session, keep = 6) {
    const s = session || getActiveSession();
    if (!s) return false;
    return compactSession(s, Math.max(2, Number(keep) || 6));
}

/* ------------------------------ 大结果 spill（对标 deepseek-harness spill 家族） ------------------------------ */
/**
 * 工具结果太大时，上下文里只放修剪版，全文存到会话级 spill，
 * 同时把定位信息（id / 原长 / 预览）交给模型——它需要细节时用 spill.read 分段取回。
 * 这样既不会撑爆窗口，也不会像过去那样「截断即丢失」。
 */
const SPILL_MAX_ITEMS = 6;
const SPILL_ITEM_CHARS = 20000;

export function pushSpill(session, tool, text) {
    const s = session || getActiveSession();
    if (!s) return null;
    const body = String(text == null ? '' : text);
    if (body.length <= RESULT_PRUNE_CHARS) return null;
    if (!Array.isArray(s.spill)) s.spill = [];
    const id = 'r' + ((Number(s.spillSeq) || 0) + 1);
    s.spillSeq = Number(s.spillSeq) + 1 || 1;
    s.spill.push({ id, tool: String(tool || ''), chars: body.length, text: body.slice(0, SPILL_ITEM_CHARS), at: nowIso() });
    while (s.spill.length > SPILL_MAX_ITEMS) s.spill.shift();
    return id;
}

export function listSpill(session) {
    const s = session || getActiveSession();
    if (!s || !Array.isArray(s.spill) || !s.spill.length) return [];
    return s.spill.map(x => ({ id: x.id, tool: x.tool, chars: x.chars, kept: String(x.text).length, preview: String(x.text).slice(0, 160) }));
}

export function readSpill(session, id, offset = 0, limit = 6000) {
    const s = session || getActiveSession();
    const hit = (s && Array.isArray(s.spill)) ? s.spill.find(x => x.id === String(id)) : null;
    if (!hit) return null;
    const from = Math.max(0, Number(offset) || 0);
    const want = Math.min(20000, Math.max(200, Number(limit) || 6000));
    const text = String(hit.text);
    const to = Math.min(from + want, text.length);
    return {
        id: hit.id,
        tool: hit.tool,
        chars_total: hit.chars,
        kept: text.length,
        from,
        to,
        text: text.slice(from, to),
        has_more: to < text.length,
        note: hit.chars > text.length ? `原文 ${hit.chars} 字，仅保留前 ${text.length} 字` : '',
    };
}

/**
 * 二道闸清理：
 *  ① 会话数超上限 → 淘汰最久未使用的（当前会话豁免）
 *  ② 总字符超预算 / 单会话超阈值 → 压成「检查点 + 最近 KEEP_ON_COMPACT 条」
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

    // 单会话超阈值的先各自压一次：压缩本身就能腾出空间，别等到总预算爆了再按时间淘汰别人
    for (const s of sessions) {
        if (sessionChars(s) > CHECKPOINT_TRIGGER_CHARS) compactSession(s);
    }

    const budget = Math.max(50000, Number(settings.sessionCharBudget) || 1200000);
    let total = 0;
    for (const s of sessions) total += sessionChars(s);
    if (total <= budget) {
        for (const s of sessions) {
            if (s.messages.length > MAX_MSGS_PER_SESSION) {
                s.messages = s.messages.slice(-MAX_MSGS_PER_SESSION);
                s.compacted = true;
            }
        }
        return;
    }

    const ordered = sessions.slice().sort((a, b) => a.updatedAt - b.updatedAt);
    for (const s of ordered) {
        if (total <= budget) break;
        if (!s.messages.length) continue;
        const before = sessionChars(s);
        if (!compactSession(s)) {
            s.messages = s.messages.slice(-4);
            s.compacted = true;
        }
        total -= (before - sessionChars(s));
    }

    // 单会话条数上限
    for (const s of sessions) {
        if (s.messages.length > MAX_MSGS_PER_SESSION) {
            s.messages = s.messages.slice(-MAX_MSGS_PER_SESSION);
            s.compacted = true;
        }
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
    // 任务在跑时不许切：批准卡 / 计划卡是挂在这块日志上的，切走会把卡一起重绘掉，
    // 那个 await 就永远等不到答复，面板看起来卡死在"生成中"。
    if (running) return false;
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
    if (running) return false;   // 同上：跑着的时候删会话同样会把待确认的卡弄丢
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

/**
 * 追加一条会话条目。
 * kind: task/final/ops 会进对话上下文；tool/plan/error 只用于界面回放。
 * opts.flush=false 走防抖落盘（一个任务里连续十几个工具时不每次都全量写盘）
 * opts.render=false 不重绘会话列表（同上，收尾时统一刷一次）
 */
export function appendTurn(role, content, kind, meta = '', opts = {}) {
    // 任务跑完才回写结论：万一运行中用户切了会话，必须写回发起任务的那个会话，
    // 否则结论会串到别人的对话里（这也是"记录像被搬走了一样"的成因之一）。
    const s = (opts.sessionId && getSession(opts.sessionId)) || getActiveSession();
    if (!s) return;
    const text = String(content == null ? '' : content);
    if (!text) return;
    // 纯过程行（计划 / 异常）同内容紧邻重复时不再落库：
    // 同一步里连着几次续写提示、同一条阶段结论反复出现，会把一个会话撑成几十条噪声，
    // 回放时用户看到一墙重复，也白白吃掉存储预算。
    if (kind === 'plan' || kind === 'error') {
        const prev = s.messages[s.messages.length - 1];
        if (prev && prev.kind === kind && prev.content === text) return;
    }
    s.messages.push({
        role,
        content: text,
        kind: kind || (role === 'user' ? 'task' : 'final'),
        meta: typeof meta === 'string' ? meta : (meta ? JSON.stringify(meta) : ''),
    });
    if (s.messages.length > MAX_MSGS_PER_SESSION) s.messages = s.messages.slice(-MAX_MSGS_PER_SESSION);
    s.updatedAt = nowIso();
    if (s.title === '新对话' || !s.title) s.title = autoTitle(text);
    if (!s.cardName) s.cardName = currentCardName();
    // 立即落盘：手机端切后台/杀进程时 beforeunload 不一定触发，靠防抖必丢
    // 副本同步写一遍：不走定时器、不受后台节流影响，这是「一说话记录就没了」的最后一道保险
    touchJournal();
    if (opts.flush === false) saveSessions();
    else flushSessions();
    if (opts.render === false) return;
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
        if (s.compacted) {
            const cp = String(s.checkpoint || '').length;
            parts.push(cp ? `已压缩${s.compactCount > 1 ? '×' + s.compactCount : ''}（检查点 ${cp} 字）` : '已压缩');
        }
        if (Array.isArray(s.spill) && s.spill.length) parts.push(`暂存 ${s.spill.length} 份大结果`);
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

// 回放时把残余的 tool_call 剥掉。宽容度要跟 index-loop 的解析器对齐：
// 模型写 name='x' 或 name=x 也要能剥，否则单引号写法会原样漏在结论里。
const TOOL_CALL_RE = /<tool_call[^>]*>[^]*?<\/tool_call[^>]*>/gi;

function stripToolCalls(text) {
    let n = 0;
    const body = String(text || '').replace(TOOL_CALL_RE, () => { n++; return ''; }).trim();
    return { body, calls: n };
}

/**
 * 回放一条工具动作。
 * 关键：这些行以前只活在 DOM 里，页面一重载（手机切后台被回收）就全没了，
 * 只剩收尾那条 ops 摘要——这就是用户说的"我一说话记录就被清空"。
 * 现在动作随会话落盘，重载后按原样重放。
 */
function renderPersistedTool(log, m) {
    let meta = {};
    try { meta = JSON.parse(m.meta || '{}') || {}; } catch { meta = {}; }
    const level = Number(meta.level) || 1;
    const ok = meta.ok !== false;

    const entry = document.createElement('div');
    entry.className = `sta-log-item sta-tool ${LEVEL_CLS[level] || 'sta-risk-1'} ${ok ? 'sta-tool-ok' : 'sta-tool-fail'}`;

    const head = document.createElement('div');
    head.className = 'sta-log-head';
    head.textContent = '工具';
    const badge = document.createElement('span');
    badge.className = `sta-risk-badge ${LEVEL_CLS[level] || 'sta-risk-1'}`;
    badge.textContent = LEVEL_LABEL[level] || '只读';
    head.appendChild(badge);

    const body = document.createElement('div');
    body.className = 'sta-log-body';
    const brief = String(meta.brief || '').trim();
    body.textContent = ok ? (brief ? `${m.content}  ${brief}` : m.content) : `${m.content} 失败`;

    entry.append(head, body);

    if (meta.result) {
        const details = document.createElement('details');
        details.className = 'sta-tool-result';
        details.innerHTML = '<summary>查看结果</summary>';
        const pre = document.createElement('pre');
        pre.textContent = String(meta.result);
        details.appendChild(pre);
        entry.appendChild(details);
    }

    log.appendChild(entry);
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

    // 有落盘的动作行时，收尾那条 ops 摘要就不用再显示了：
    // 它和动作行说的是同一件事，重复摆两条只会让日志变吵。
    // （它仍留在会话里，作为"上一轮动作"进上下文。）
    const hasToolRows = s.messages.some(m => m.kind === 'tool');

    for (const m of s.messages) {
        if (m.kind === 'tool') { renderPersistedTool(view.log, m); continue; }
        if (m.kind === 'ops' && hasToolRows) continue;
        const entry = document.createElement('div');
        const isUser = m.role === 'user';
        const kindCls = m.kind === 'ops' ? 'sta-ops-summary'
            : m.kind === 'plan' ? 'sta-plan-line'
                : m.kind === 'error' ? 'sta-error' : 'sta-final';
        entry.className = 'sta-log-item ' + (isUser ? 'sta-user' : kindCls);

        const head = document.createElement('div');
        head.className = 'sta-log-head';
        head.textContent = isUser ? '你' : (m.kind === 'ops' ? '动作'
            : m.kind === 'plan' ? '计划'
                : m.kind === 'error' ? '异常' : 'Agent');

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
    if (!s || (!s.messages.length && !s.checkpoint)) return [];
    // tool/plan/error 是给人看的过程记录，不进上下文：tool 行没有结果（结果已单独作为 tool_result 传过），
    // 全带上只会把窗口塞满、还让模型以为这些是自己在说的
    const rows = s.messages
        .filter(m => m.kind !== 'tool' && m.kind !== 'plan' && m.kind !== 'error')
        .map(m => ({
            role: m.role,
            content: m.kind === 'ops'
                ? `（上一轮动作：${m.content}）`
                : String(m.content == null ? '' : m.content),
        }))
        // 老会话里存着模型写坏的调用块（<call_call ...>、它自己伪造的 <tool_result ...>）。
        // 原样回灌等于教它继续这么写，所以每次取上下文都清一遍——旧脏档也跟着自愈。
        .map(m => (m.role === 'assistant' ? { role: m.role, content: stripToolMarkup(m.content) } : m))
        .filter(m => m.content && m.content.trim());
    // 检查点放最前面：它代替了被压缩掉的老消息，模型从这份摘要接着干（deepseek-harness 的做法）
    if (s.checkpoint && String(s.checkpoint).trim()) {
        rows.unshift({ role: 'user', content: String(s.checkpoint).trim() });
    }
    return rows;
}
