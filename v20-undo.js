import { getContext } from '../../../extensions.js';
import { api } from './v20-lib.js';
import { JOURNALS } from './v20-plan.js';

const c = () => getContext();

export async function opsUndo(a) {
    const journal = JOURNALS.find(j => j.id === a.id);
    if (!journal) throw new Error(`没有这个批次：${a.id}`);
    if (journal.undoneAt) throw new Error(`该批次已在 ${new Date(journal.undoneAt).toLocaleString()} 回滚过`);

    const restored = [];
    const failedRestores = [];

    for (const snap of [...journal.snapshots].reverse()) {
        try {
            if (snap.kind === 'world') {
                if (snap.existed && snap.data) {
                    await c().saveWorldInfo(snap.name, snap.data, true);
                    restored.push(`world:${snap.name}`);
                } else {
                    // 执行前不存在 → 现在如果存在就删掉
                    await api('/api/worldinfo/delete', { name: snap.name });
                    await c().updateWorldInfoList?.();
                    restored.push(`world:${snap.name}（删除本批创建的）`);
                }
            }
            if (snap.kind === 'char' && snap.fields) {
                const FIELDS = ['cardName', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'tags', 'creator', 'character_version', 'world', 'talkativeness', 'depth_prompt', 'extensions', 'unset'];
                let count = 0;
                for (const field of FIELDS) {
                    if (snap.fields[field] === undefined) continue;
                    await api('/api/characters/edit-attribute', {
                        avatar_url: snap.avatar,
                        ch_name: snap.fields.name,
                        field,
                        value: snap.fields[field],
                    });
                    count++;
                }
                restored.push(`char:${snap.name}（${count} 字段）`);
            }
            if (snap.kind === 'setting') {
                const all = await api('/api/settings/get', {});
                const parts = String(snap.path).split('.').filter(Boolean);
                let cursor = all;
                for (const key of parts.slice(0, -1)) {
                    if (cursor[key] === undefined) cursor[key] = {};
                    cursor = cursor[key];
                }
                const last = parts[parts.length - 1];
                if (snap.existed) cursor[last] = snap.old;
                else delete cursor[last];
                await api('/api/settings/save', all);
                restored.push(`setting:${snap.path}${snap.existed ? '' : '（删除本批新增的键）'}`);
            }
        } catch (error) {
            failedRestores.push({ kind: snap.kind, target: snap.name || snap.path, message: error.message });
        }
    }

    journal.undoneAt = Date.now();
    await c().updateWorldInfoList?.();
    return Object.freeze({
        ok: failedRestores.length === 0,
        journal: journal.id,
        restored,
        failed: failedRestores,
        note: '回滚只覆盖世界书 / 角色字段 / 设置键；聊天楼层、正则、脚本、预设无法自动回滚。回滚后建议刷新页面。',
    });
}
