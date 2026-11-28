/**
 * 会话历史检索（对标 deepseek-harness packages/session-query + experimental/tool-session-query）
 *
 * 照抄的原则：
 *   1. **无游标**：不给模型 offset / limit / cursor。结果到上限就让它缩小查询，绝不暴露分页。
 *   2. **搜别人的先搜**：`session.search` 默认**排除当前会话**（DSH 原话：搜索始终省略调用方会话），
 *      要搜自己得显式 include_current。
 *   3. **命中带摘录**：不只给"哪个会话有"，要给命中的那一条 + 前后 50 字，不然模型还得再读一次。
 *   4. **精确读取只读一条**：`session.read` 给完整正文（截 6000）+ 可选前后邻居摘要，不整段回放。
 * 本地化：没有 cwd/工作区授权（我们都是同一个酒馆存储），权限维度砍掉。
 */

import { allSessions, getSession, getActiveSession } from './index-sessions.js';

const MAX_SESSION_HITS = 20;
const MAX_EVENT_HITS = 30;

function norm(x) {
    return String(x || '').toLowerCase();
}

function snippetAround(content, query) {
    const src = String(content || '').replace(/\s+/g, ' ').trim();
    if (!src) return '';
    const q = String(query || '').trim();
    if (!q) return src.slice(0, 120);
    const at = norm(src).indexOf(norm(q));
    if (at < 0) return src.slice(0, 120);
    const from = Math.max(0, at - 50);
    const to = Math.min(src.length, at + q.length + 70);
    return (from > 0 ? '…' : '') + src.slice(from, to) + (to < src.length ? '…' : '');
}

function resolveSession(id) {
    const want = String(id || 'current').trim();
    if (!want || want === 'current' || want === 'active') return getActiveSession();
    return getSession(want);
}

/** 跨会话搜：返回会话列表 + 每个会话的最佳命中摘录（排除当前会话，DDL 同款） */
export function searchSessions({ query, include_current = false } = {}) {
    const q = String(query || '').trim();
    if (!q) throw new Error('session.search 需要 query（一句原文片段最好，别用整段话）');
    const cur = getActiveSession();
    const list = allSessions().filter(s => (include_current ? true : !cur || s.id !== cur.id));
    const hits = [];
    for (const s of list) {
        const msgs = Array.isArray(s.messages) ? s.messages : [];
        let count = 0;
        let best = null;
        let bestScore = -1;
        msgs.forEach((m, idx) => {
            if (!m) return;
            const c = String(m.content || '');
            const meta = String(m.meta || '');
            if (!norm(c).includes(norm(q)) && !norm(meta).includes(norm(q))) return;
            count += 1;
            // 命中越靠后（越新）+ 正文越短 → 越像"就是这条"，优先给它
            const score = (idx / Math.max(1, msgs.length)) * 10 + (q.length / Math.max(1, c.length)) * 40;
            if (score > bestScore) {
                bestScore = score;
                best = { idx, kind: m.kind || '', role: m.role || '', snippet: snippetAround(c || meta, q) };
            }
        });
        if (!count) continue;
        hits.push({
            id: s.id,
            title: String(s.title || ''),
            messages: msgs.length,
            hits: count,
            updatedAt: s.updatedAt || 0,
            best,
        });
    }
    hits.sort((a, b) => (b.hits - a.hits) || (b.updatedAt - a.updatedAt));
    return {
        query: q,
        scanned: list.length,
        sessions: hits.slice(0, MAX_SESSION_HITS),
        truncated: hits.length > MAX_SESSION_HITS,
        note: hits.length > MAX_SESSION_HITS ? `命中 ${hits.length} 个会话，只给前 ${MAX_SESSION_HITS} 个——把 query 缩窄再搜` : '',
    };
}

/** 单个会话内搜：给每条命中的 idx + 摘录，后面可以 session.read 打开 */
export function matchEvents({ session = 'current', query } = {}) {
    const s = resolveSession(session);
    if (!s) throw new Error(`没有 ${session} 这个会话`);
    const q = String(query || '').trim();
    if (!q) throw new Error('session.match 需要 query');
    const msgs = Array.isArray(s.messages) ? s.messages : [];
    const out = [];
    msgs.forEach((m, idx) => {
        if (!m) return;
        const c = String(m.content || '');
        const meta = String(m.meta || '');
        if (!norm(c).includes(norm(q)) && !norm(meta).includes(norm(q))) return;
        out.push({ idx, kind: m.kind || '', role: m.role || '', snippet: snippetAround(c || meta, q) });
    });
    return {
        session: s.id,
        title: String(s.title || ''),
        messages: msgs.length,
        total: out.length,
        events: out.slice(0, MAX_EVENT_HITS),
        truncated: out.length > MAX_EVENT_HITS,
    };
}

/** 读一条：完整正文（截 6000）+ 可选前后邻居摘要 */
export function readEvent({ session = 'current', idx, neighbors = true } = {}) {
    const s = resolveSession(session);
    if (!s) throw new Error(`没有 ${session} 这个会话`);
    const i = Number(idx);
    const msgs = Array.isArray(s.messages) ? s.messages : [];
    const m = msgs[i];
    if (!m) throw new Error(`第 ${idx} 条不存在（这个会话共 ${msgs.length} 条，idx 从 0 开始）`);
    const near = (k) => (msgs[k] ? { idx: k, kind: msgs[k].kind || '', role: msgs[k].role || '', snippet: String(msgs[k].content || '').replace(/\s+/g, ' ').slice(0, 200) } : null);
    return {
        session: s.id,
        title: String(s.title || ''),
        idx: i,
        kind: m.kind || '',
        role: m.role || '',
        meta: String(m.meta || '').slice(0, 3000),
        content: String(m.content || '').slice(0, 6000),
        truncated: String(m.content || '').length > 6000,
        before: neighbors ? [near(i - 2), near(i - 1)].filter(Boolean) : [],
        after: neighbors ? [near(i + 1), near(i + 2)].filter(Boolean) : [],
    };
}

export const SEARCH_LIMITS = { MAX_SESSION_HITS, MAX_EVENT_HITS };
