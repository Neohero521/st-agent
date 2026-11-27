/**
 * v1.8 工具层：酒馆的「安全网」与「磁盘管家」。
 *
 * 这一版来自对 src/endpoints 全部 46 个模块的逐文件核对，挑出三块 125 个工具里
 * 一个都没碰过的服务端能力：
 *
 *   1. settings 快照（/api/settings/get-snapshots|make-snapshot|load-snapshot|restore-snapshot）
 *      —— Agent 要批量改设置之前，先打一张快照，改坏了能退回。
 *   2. data-maid（/api/data-maid/report|delete）—— 真正扫磁盘，找孤立文件：
 *      没有卡认领的聊天、没人用的缩略图、旧备份。audit.run 只做统计，这个是能落地的清理。
 *   3. chats 备份（/api/backups/chat/get|delete）—— 酒馆自己给聊天打的 .jsonl 备份。
 *
 * 附带向量库（/api/vector/*）与统计（/api/stats/*）：前者是记忆检索的底层，
 * 后者是「我在哪个角色身上花的时间最多」。
 */
import { getContext } from '../../../extensions.js';

const c = () => getContext();

/* ------------------------------ HTTP ------------------------------ */

async function call(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { ...c().getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    if (!res.ok) {
        const err = new Error(`${url} → HTTP ${res.status}${text && text.length < 200 ? ' ' + text : ''}`);
        err.status = res.status;
        throw err;
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
}

/* ------------------------------ 设置快照 ------------------------------ */

async function snapList() {
    const list = await call('/api/settings/get-snapshots', {});
    if (!Array.isArray(list)) throw new Error('快照列表返回结构异常');
    const rows = list
        .map(s => ({ name: s.name, date: s.date ? new Date(s.date).toISOString() : null, kb: Math.round((s.size || 0) / 1024) }))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return {
        count: rows.length,
        snapshots: rows.slice(0, 30),
        total_kb: rows.reduce((s, r) => s + r.kb, 0),
        hint: '快照是整份 settings.json 的拷贝，存在 data/<user>/backups/ 下。改大批设置前先 snap.make 一张。',
    };
}

async function snapMake() {
    const before = await call('/api/settings/get-snapshots', {});
    const n0 = Array.isArray(before) ? before.length : 0;
    await call('/api/settings/make-snapshot', {});
    const after = await call('/api/settings/get-snapshots', {});
    const list = Array.isArray(after) ? after : [];
    const newest = list.slice().sort((a, b) => (b.date || 0) - (a.date || 0))[0];
    return {
        ok: true,
        before: n0,
        after: list.length,
        made: list.length > n0 ? newest?.name ?? '(新快照未出现)' : '(没新增，可能同一秒内重复触发)',
        hint: '快照立刻落盘，restore 后需要刷新页面才会重新读设置。',
    };
}

async function snapLoad({ name } = {}) {
    if (!name) throw new Error('需要 name（snap.list 里的文件名）');
    const raw = await call('/api/settings/load-snapshot', { name });
    let parsed = raw;
    if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw); } catch { return { ok: true, name, chars: raw.length, parsed: false }; }
    }
    const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];
    return {
        ok: true,
        name,
        parsed: true,
        chars: typeof raw === 'string' ? raw.length : JSON.stringify(parsed ?? {}).length,
        top_keys: keys.slice(0, 30),
        top_key_count: keys.length,
        has: {
            characters: !!parsed?.characters,
            world_info: !!parsed?.world_info,
            power_user: !!parsed?.power_user,
            extension_settings: !!parsed?.extension_settings,
        },
        hint: '只回结构不回全文（settings.json 常有几 MB）。要看某一段就用 restore 之后读 setting.get。',
    };
}

async function snapRestore({ name, confirm } = {}) {
    if (!name) throw new Error('需要 name');
    if (confirm !== true) throw new Error('restore 会整份覆盖当前 settings.json（不可撤销），确认就传 confirm: true');
    await call('/api/settings/restore-snapshot', { name });
    return {
        ok: true,
        name,
        note: 'settings.json 已被快照整份覆盖。现在页面里还是旧内存值，必须刷新页面才会加载新设置。',
        hint: '刷新后建议 snap.make 一张"恢复后"的快照，方便再退回来。',
    };
}

/* ------------------------------ 聊天备份 ------------------------------ */

async function backupChats({ limit = 20 } = {}) {
    const list = await call('/api/backups/chat/get', {});
    if (!Array.isArray(list)) throw new Error('备份列表返回结构异常');
    return {
        count: list.length,
        // getChatInfo 的真实字段是 chat_items（楼层数）/ mes（最后一条）/ last_mes（mtime 数字）/ file_size（格式化字符串）
        backups: list.slice(0, Number(limit) || 20).map(b => ({
            file: b.file_name,
            size: b.file_size ?? null,
            messages: b.chat_items ?? null,
            last_text: typeof b.mes === 'string' ? b.mes.slice(0, 80) : null,
            last: b.last_mes ? new Date(b.last_mes).toISOString() : null,
        })),
        hint: '这些是酒馆在保存聊天时自动打到 backups/ 的 .jsonl。删之前建议先确认当前聊天没坏。',
    };
}

async function backupDelete({ name } = {}) {
    if (!name) throw new Error('需要 name（backup.chats 里的 file_name）');
    await call('/api/backups/chat/delete', { name });
    return { ok: true, deleted: name };
}

/* ------------------------------ 磁盘管家 ------------------------------ */

const MAID_KINDS = ['images', 'files', 'chats', 'groupChats', 'avatarThumbnails', 'backgroundThumbnails', 'personaThumbnails', 'chatBackups', 'settingsBackups'];

async function maidReport({ preview = 5 } = {}) {
    const data = await call('/api/data-maid/report', {});
    const report = data?.report || {};
    const rows = MAID_KINDS.map(k => {
        const arr = Array.isArray(report[k]) ? report[k] : [];
        const bytes = arr.reduce((s, x) => s + (Number(x.size) || 0), 0);
        return {
            kind: k,
            count: arr.length,
            kb: Math.round(bytes / 1024),
            sample: arr.slice(0, Number(preview) || 5).map(x => ({ name: x.name, hash: x.hash, kb: Math.round((Number(x.size) || 0) / 1024) })),
        };
    });
    const total = rows.reduce((s, r) => s + r.count, 0);
    const totalKb = rows.reduce((s, r) => s + r.kb, 0);
    return {
        ok: true,
        total: total,
        total_kb: totalKb,
        rows,
        token: data?.token ?? null,
        note: 'total 是"磁盘上存在但没有被任何卡/聊天认领"的文件数。删必须带这个 token + 具体 hash（maid.delete），不能一把梭。',
        advice: total === 0
            ? ['磁盘很干净，没有孤立文件。']
            : rows.filter(r => r.count).map(r => `${r.kind}: ${r.count} 个（${r.kb} KB）`),
    };
}

async function maidDelete({ token, hashes, confirm } = {}) {
    if (!token) throw new Error('需要 token（先用 maid.report 拿，它跟这一份报告绑定）');
    if (!Array.isArray(hashes) || !hashes.length) throw new Error('需要 hashes 数组（要删的具体文件 hash，不是"全部"）');
    if (confirm !== true) throw new Error('删除不可恢复，确认就传 confirm: true');
    await call('/api/data-maid/delete', { token, hashes });
    return {
        ok: true,
        requested: hashes.length,
        note: '服务端按 token 校验归属并逐个 unlink；不在本次报告里的 hash 会被忽略。删完 token 会失效，要再删得重新 maid.report。',
    };
}

/* ------------------------------ 向量库 ------------------------------ */

function vecArgs({ collectionId, source, model } = {}) {
    const body = {};
    if (collectionId) body.collectionId = String(collectionId);
    if (source) body.source = String(source);
    if (model) body.model = String(model);
    return body;
}

async function vecList({ collectionId, source, model } = {}) {
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

async function vecQuery({ collectionId, searchText, topK = 10, threshold = 0, source, model } = {}) {
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

async function vecInsert({ collectionId, items, source, model } = {}) {
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

async function vecPurge({ collectionId, everything, confirm } = {}) {
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

async function statsGet({ top = 10 } = {}) {
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

async function statsRecreate() {
    const started = Date.now();
    await call('/api/stats/recreate', {});
    return { ok: true, ms: Date.now() - started, note: '已按磁盘上的聊天文件重建统计。' };
}

/* ------------------------------ 导出 ------------------------------ */

export const TOOLS = [
    {
        name: 'snap.list', kind: 'read',
        desc: '列 settings 快照：文件名、时间、体积、总量。快照存在 data/<user>/backups/，是整份 settings.json 的拷贝。',
        params: {},
        run: () => snapList(),
    },
    {
        name: 'snap.make', kind: 'write',
        desc: '立刻给当前 settings.json 打一张快照。批量改设置、装扩展、换主题之前先打一张，出事能退回。',
        params: {},
        run: () => snapMake(),
    },
    {
        name: 'snap.load', kind: 'read',
        desc: '读一张快照的结构（顶层键、字符数、是否含 characters/world_info/power_user），不返回全文。',
        params: { name: '快照文件名' },
        run: a => snapLoad(a),
    },
    {
        name: 'snap.restore', kind: 'dangerous',
        desc: '用快照整份覆盖当前 settings.json。不可撤销，必须 confirm: true；覆盖后要刷新页面才生效。',
        params: { name: '快照文件名', confirm: '必须 true' },
        run: a => snapRestore(a),
    },
    {
        name: 'backup.chats', kind: 'read',
        desc: '列酒馆自动打的聊天备份（backups/*.jsonl）：文件名、体积、楼层数、最后一条文本。',
        params: { limit: '最多列几条，默认 20' },
        run: a => backupChats(a),
    },
    {
        name: 'backup.delete', kind: 'dangerous',
        desc: '删一个聊天备份文件。删之前先确认当前聊天本身没坏。',
        params: { name: '备份文件名（backup.chats 里的 file）' },
        run: a => backupDelete(a),
    },
    {
        name: 'maid.report', kind: 'read',
        desc: '扫磁盘找孤立文件（data-maid 报告）：没人认领的聊天、图片、附件、缩略图、旧备份、旧设置快照，按类给数量与体积，并返回本次专属 token。这是 audit.run 的落地版——它看的是真实磁盘。',
        params: { preview: '每类给几条样例，默认 5' },
        run: a => maidReport(a),
    },
    {
        name: 'maid.delete', kind: 'dangerous',
        desc: '按 maid.report 的 token + 具体 hash 删孤立文件（必须是报告里出现过的 hash，不能一把梭）。要 confirm: true。',
        params: { token: 'maid.report 返回的 token', hashes: '要删的 hash 数组', confirm: '必须 true' },
        run: a => maidDelete(a),
    },
    {
        name: 'vec.list', kind: 'read',
        desc: '看某个向量集合（通常一档聊天一个集合）已经索引了多少条：返回数量与前 20 个 hash。',
        params: { collectionId: '集合名，通常=聊天档名', source: '向量源，默认 transformers', model: 'embedding 模型（openai 等源需要）' },
        run: a => vecList(a),
    },
    {
        name: 'vec.query', kind: 'read',
        desc: '在向量集合里语义检索：给一段话，返回最像的楼层（index / hash / score / 前 160 字）。这是酒馆记忆检索的底层，能验证「记忆到底能不能被召回」。',
        params: { collectionId: '集合名', searchText: '查询文本', topK: '返回条数，默认 10', threshold: '相似度下限，0~1', source: '向量源', model: 'embedding 模型' },
        run: a => vecQuery(a),
    },
    {
        name: 'vec.insert', kind: 'write',
        desc: '往向量集合里写条目（{hash, text, index} 数组）。可用于手动补索引、或把外部笔记塞进记忆库。',
        params: { collectionId: '集合名', items: '数组', source: '向量源', model: 'embedding 模型' },
        run: a => vecInsert(a),
    },
    {
        name: 'vec.purge', kind: 'dangerous',
        desc: '清掉某个集合的索引（everything: true 则清整个向量源目录）。下次检索会自动重建，但重建要花时间。',
        params: { collectionId: '集合名', everything: 'true=全清', confirm: '全清时必须 true' },
        run: a => vecPurge(a),
    },
    {
        name: 'stats.get', kind: 'read',
        desc: '读酒馆统计（每个角色累计消息量等），按量排序取前 N。用来回答「我聊得最多的是谁」。',
        params: { top: '取前几名，默认 10' },
        run: a => statsGet(a),
    },
    {
        name: 'stats.recreate', kind: 'write',
        desc: '从磁盘上的聊天文件重建统计（会遍历全部聊天，慢，但能修掉数字对不上的情况）。',
        params: {},
        run: () => statsRecreate(),
    },
];
