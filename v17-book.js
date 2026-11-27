import { c } from './v17-lib.js';

/* ------------------------------ 角色卡内嵌世界书 ------------------------------ */

export function findChar(avatar) {
    const chars = c().characters || [];
    if (avatar) return chars.find(x => x.avatar === avatar) || chars.find(x => x.name === avatar);
    return chars[Number(c().characterId)];
}

export async function charBook({ avatar, limit = 5 } = {}) {
    const ch = findChar(avatar);
    if (!ch) throw new Error('找不到角色卡：传 avatar 或用带名字的 avatar');
    const book = ch.data?.character_book;
    if (!book) {
        return { ok: true, avatar: ch.avatar, name: ch.name, has_book: false, hint: '这张卡没有内嵌世界书（data.character_book 为空）；它的世界书绑定应该看 data.extensions.world。' };
    }
    const entries = book.entries || [];
    return {
        ok: true,
        avatar: ch.avatar,
        name: ch.name,
        has_book: true,
        book_name: book.name || null,
        entries: entries.length,
        linked_world: ch.data?.extensions?.world || null,
        preview: entries.slice(0, Number(limit) || 5).map(e => ({
            id: e.id,
            comment: e.comment,
            keys: e.keys,
            enabled: e.enabled,
            insertion_order: e.insertion_order,
            chars: (e.content || '').length,
        })),
    };
}

export async function charBookExtract({ avatar, world_name, overwrite = false } = {}) {
    const ch = findChar(avatar);
    if (!ch) throw new Error('找不到角色卡');
    const book = ch.data?.character_book;
    if (!book || !(book.entries || []).length) throw new Error('这张卡没有内嵌世界书，没东西可抽');

    const target = String(world_name || book.name || `${ch.name} - 内嵌书`).trim();
    const existing = (c().getWorldInfoNames?.() || []);
    if (existing.includes(target) && !overwrite) throw new Error(`世界书「${target}」已存在；确认覆盖就传 overwrite: true`);

    // 用酒馆自己的转换器把 character_book 转成世界书结构，别自己手搓字段（position/enabled 这些是反的）
    const wi = await import('/scripts/world-info.js');
    if (typeof wi.convertCharacterBook !== 'function') throw new Error('当前酒馆版本没有导出 convertCharacterBook');
    const converted = wi.convertCharacterBook(structuredClone(book));

    if (!existing.includes(target)) {
        // 走一条所有版本都稳的路：先落一个空本占位，再把真实内容写进去
        await c().saveWorldInfo(target, { entries: {} }, true);
    }
    await c().saveWorldInfo(target, converted, true);
    try { c().reloadWorldInfoEditor?.(target, true); } catch { /* ignore */ }

    return {
        ok: true,
        avatar: ch.avatar,
        world_name: target,
        entries: Object.keys(converted.entries || {}).length,
        overwritten: existing.includes(target),
        hint: '抽取只写了新世界书，原卡的内嵌书没动。想让它生效：lore.bind 给角色绑上，或用 lb.setGlobal 设成全局。',
    };
}
