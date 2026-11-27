import { call } from './v18-lib.js';

/* ------------------------------ 磁盘管家 ------------------------------ */

export const MAID_KINDS = ['images', 'files', 'chats', 'groupChats', 'avatarThumbnails', 'backgroundThumbnails', 'personaThumbnails', 'chatBackups', 'settingsBackups'];

export async function maidReport({ preview = 5 } = {}) {
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

export async function maidDelete({ token, hashes, confirm } = {}) {
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
