import { call } from './v18-lib.js';

/* ------------------------------ 向量库 ------------------------------ */

export function vecArgs({ collectionId, source, model } = {}) {
    const body = {};
    if (collectionId) body.collectionId = String(collectionId);
    if (source) body.source = String(source);
    if (model) body.model = String(model);
    return body;
}

export async function vecList({ collectionId, source, model } = {}) {
    if (!collectionId) throw new Error('需要 collectionId（通常就是聊天档名，如「角色名 - 2026-11-26@23h41m26s623ms」）');
    const hashes = await call('/api/vector/list', vecArgs({ collectionId, source, model }));
    const arr = Array.isArray(hashes) ? hashes : [];
    return {
        ok: true,
        collectionId,
        source: source || 'transformers',
        count: arr.length,
        hashes: arr.slice(0, 20),
        hint: 'count 就是这一档聊天已经建过索引的楼层数。为 0 说明这档没被向量化过。',
    };
}

export async function vecQuery({ collectionId, searchText, topK = 10, threshold = 0, source, model } = {}) {
    if (!collectionId) throw new Error('需要 collectionId');
    if (!searchText) throw new Error('需要 searchText');
    const results = await call('/api/vector/query', {
        ...vecArgs({ collectionId, source, model }),
        searchText,
        topK: Number(topK) || 10,
        threshold: Number(threshold) || 0,
    });
    const arr = Array.isArray(results) ? results : [];
    return {
        ok: true,
        collectionId,
        hits: arr.length,
        results: arr.slice(0, Number(topK) || 10).map(r => ({
            index: r.index,
            hash: r.hash,
            score: typeof r.score === 'number' ? Math.round(r.score * 1000) / 1000 : r.score,
            text: typeof r.text === 'string' ? r.text.slice(0, 160) : undefined,
        })),
        hint: 'score 越高越像。threshold 默认 0 = 不过滤，调 0.3~0.5 通常更干净。',
    };
}

export async function vecInsert({ collectionId, items, source, model } = {}) {
    if (!collectionId) throw new Error('需要 collectionId');
    if (!Array.isArray(items) || !items.length) throw new Error('需要 items 数组，每项 {hash, text, index}');
    const okItems = items.filter(x => x && typeof x.text === 'string' && x.text.trim());
    if (!okItems.length) throw new Error('items 里没有有效的 text');
    await call('/api/vector/insert', {
        ...vecArgs({ collectionId, source, model }),
        items: okItems.map((x, i) => ({ hash: Number(x.hash ?? i), text: String(x.text), index: Number(x.index ?? x.hash ?? i) })),
    });
    return { ok: true, collectionId, inserted: okItems.length };
}

export async function vecPurge({ collectionId, everything, confirm } = {}) {
    if (everything) {
        if (confirm !== true) throw new Error('purge-all 会清掉整个向量源目录（所有集合），确认就传 confirm: true');
        await call('/api/vector/purge-all', {});
        return { ok: true, purged: 'all', note: '所有集合的索引都被删了，下次检索会重建。' };
    }
    if (!collectionId) throw new Error('需要 collectionId，或者 everything: true 清全部');
    await call('/api/vector/purge', vecArgs({ collectionId }));
    return { ok: true, purged: collectionId };
}

/* ------------------------------ 统计 ------------------------------ */

export async function statsGet({ top = 10 } = {}) {
    const stats = await call('/api/stats/get', {});
    if (!stats || typeof stats !== 'object') return { ok: true, empty: true, stats };
    // 统计对象里混着 timestamp 这类元数据（值是数字），只留真正按角色聚合的条目
    const entries = Object.entries(stats).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
    const rows = entries
        .map(([avatar, v]) => ({ avatar, ...v }))
        .sort((a, b) => (Number(b.non_user_msg_count ?? b.user_msg_count ?? 0)) - (Number(a.non_user_msg_count ?? a.user_msg_count ?? 0)));
    return {
        ok: true,
        characters: entries.length,
        top: rows.slice(0, Number(top) || 10),
        hint: '统计由酒馆按聊天档累计，怀疑数字不对就用 stats.recreate 从聊天文件重建（会读全部聊天，慢）。',
    };
}

export async function statsRecreate() {
    const started = Date.now();
    await call('/api/stats/recreate', {});
    return { ok: true, ms: Date.now() - started, note: '已按磁盘上的聊天文件重建统计。' };
}
