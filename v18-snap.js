import { call } from './v18-lib.js';

/* ------------------------------ 设置快照 ------------------------------ */

export async function snapList() {
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

export async function snapMake() {
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

export async function snapLoad({ name } = {}) {
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

export async function snapRestore({ name, confirm } = {}) {
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

export async function backupChats({ limit = 20 } = {}) {
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

export async function backupDelete({ name } = {}) {
    if (!name) throw new Error('需要 name（backup.chats 里的 file_name）');
    await call('/api/backups/chat/delete', { name });
    return { ok: true, deleted: name };
}
