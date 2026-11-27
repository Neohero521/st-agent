import { getContext } from '../../../extensions.js';
import { findCharacter, readPath, short, api } from './v20-lib.js';

const c = () => getContext();

/* ------------------------------ 可批处理清单 ------------------------------ */

/**
 * predict(args) 返回 { change, note?, warnings?, error? }
 * change ∈ create / create-book / update / delete / noop / unknown / error / blocked
 */
export const CATALOG = (window.__staOpsCatalog = window.__staOpsCatalog || new Map());

export function reg(tool, level, undo, target, predict) {
    CATALOG.set(tool, { tool, level, undo, target, predict });
}

/* ---- 世界书 ---- */

reg('world.create', 2, 'none',
    a => `世界书 ${a.name}`,
    async a => {
        if (!a.name) return { error: '缺少 name（世界书名）' };
        const exists = (c().getWorldInfoNames?.() ?? []).includes(a.name) || !!(await c().loadWorldInfo(a.name).catch(() => null));
        return exists ? { change: 'noop', note: '同名世界书已存在，create 不会覆盖' } : { change: 'create' };
    });

reg('world.upsertEntry', 2, 'world',
    a => `${a.name || '?'} / ${a.comment || '?'}`,
    async a => {
        if (!a.name) return { error: '缺少 name（世界书名）' };
        if (!a.comment) return { error: '缺少 comment（条目标题）' };
        const data = await c().loadWorldInfo(a.name).catch(() => null);
        if (!data) return { change: 'create-book', note: '世界书不存在，会先新建一本', warnings: ['目标世界书不存在'] };
        const entries = data.entries || {};
        const hit = Object.entries(entries).find(([, e]) => e?.comment === a.comment);
        if (!hit) return { change: 'create', note: `新增条目（现有 ${Object.keys(entries).length} 条）` };
        let patch = a.entry || {};
        if (typeof patch === 'string') {
            try { patch = JSON.parse(patch); } catch { return { error: 'entry 不是合法 JSON' }; }
        }
        if (patch.insertion_order !== undefined) { patch.order = patch.insertion_order; delete patch.insertion_order; }
        if (patch.enabled !== undefined) { patch.disable = !patch.enabled; delete patch.enabled; }
        const changed = Object.keys(patch).filter(k => JSON.stringify(hit[1]?.[k]) !== JSON.stringify(patch[k]));
        if (!changed.length) return { change: 'noop', note: '内容与现有条目一致' };
        return { change: 'update', note: `字段变化：${changed.join(', ')}` };
    });

reg('world.deleteEntry', 2, 'world',
    a => `${a.name || '?'} / ${a.comment || '?'}`,
    async a => {
        if (!a.name || !a.comment) return { error: '需要 name 与 comment' };
        const data = await c().loadWorldInfo(a.name).catch(() => null);
        if (!data) return { error: `世界书不存在：${a.name || '未指定世界书名'}` };
        const hit = Object.entries(data.entries || {}).find(([, e]) => e?.comment === a.comment);
        return hit ? { change: 'delete', warnings: [`将删除条目「${a.comment}」`] } : { error: `条目不存在：${a.comment}` };
    });

reg('world.save', 3, 'world',
    a => `世界书 ${a.name}（整本覆盖）`,
    async a => {
        if (!a.name) return { error: '缺少 name' };
        let data = a.data;
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch { return { error: 'data 不是合法 JSON' }; }
        }
        if (!data || typeof data !== 'object') return { error: 'data 必须是对象' };
        const current = await c().loadWorldInfo(a.name).catch(() => null);
        const before = Object.keys(current?.entries || {}).length;
        const after = Object.keys(data.entries || {}).length;
        return {
            change: 'update',
            warnings: [`整本覆盖：条目 ${before} → ${after}`],
        };
    });

reg('world.delete', 3, 'none',
    a => `世界书 ${a.name}`,
    async a => {
        if (!a.name) return { error: '缺少 name' };
        const data = await c().loadWorldInfo(a.name).catch(() => null);
        return data ? { change: 'delete', warnings: [`将删除整本世界书「${a.name}」`] } : { error: `世界书不存在：${a.name || '未指定世界书名'}` };
    });

/* ---- 角色卡 ---- */

reg('char.edit', 2, 'char',
    a => `角色 ${a.name || '（当前）'}`,
    async a => {
        const ch = findCharacter(a.name);
        if (!ch) return { error: `未找到角色：${a.name || '（当前）'}` };
        const FIELDS = ['cardName', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'tags', 'creator', 'character_version', 'world', 'talkativeness', 'depth_prompt', 'extensions', 'unset'];
        const changed = FIELDS.filter(f => a[f] !== undefined && JSON.stringify(ch[f]) !== JSON.stringify(a[f]));
        if (!changed.length) return { change: 'noop', note: '传入字段与当前值一致' };
        return { change: 'update', note: `字段变化：${changed.join(', ')}` };
    });

reg('char.rename', 2, 'none',
    a => `角色 ${a.name || '（当前）'} → ${a.newName || '?'}`,
    async a => {
        const ch = findCharacter(a.name);
        if (!ch) return { error: `未找到角色：${a.name || '（当前）'}` };
        if (!a.newName) return { error: '缺少 newName' };
        const dup = (c().characters ?? []).some(x => x.name === a.newName && x.avatar !== ch.avatar);
        return dup ? { error: `已存在同名角色：${a.newName}` } : { change: 'update' };
    });

reg('char.delete', 3, 'none',
    a => `角色 ${a.name || '（当前）'}`,
    async a => {
        const ch = findCharacter(a.name);
        return ch ? { change: 'delete', warnings: [`将删除角色卡「${ch.name}」及其聊天记录`] } : { error: `未找到角色：${a.name || '当前没有选中的角色'}` };
    });

/* ---- 聊天 ---- */

reg('chat.append', 2, 'none',
    a => `聊天 ${a.name || '（当前）'}`,
    async a => (a.text ? { change: 'create', note: `追加 ${String(a.text).length} 字符` } : { error: '缺少 text' }));

reg('chat.editMessage', 2, 'none',
    a => `聊天 ${a.name || '（当前）'} 第 ${a.index ?? '?'} 楼`,
    async a => (a.index === undefined && a.mesId === undefined ? { error: '需要 index 或 mesId' } : { change: 'update' }));

reg('chat.deleteMessage', 3, 'none',
    a => `聊天 ${a.name || '（当前）'} 第 ${a.index ?? a.mesId ?? '?'} 楼`,
    async a => (a.index === undefined && a.mesId === undefined ? { error: '需要 index 或 mesId' } : { change: 'delete', warnings: ['删除聊天楼层'] }));
