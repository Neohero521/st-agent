/**
 * 写后刷新中枢（v1.13.0）
 *
 * 背景：Agent 改完世界书 / 角色卡后，酒馆侧栏还是旧数据，用户得手动刷新页面才看得见。
 * 这里按"改的是哪类东西"去调酒馆的刷新链路，工具执行完统一过一遍。
 *
 * 世界书为什么不能只调 updateWorldInfoList：
 *   它是从 /api/settings/get 的 world_names 字段拿清单的，而那个字段是酒馆**启动时**扫盘的结果。
 *   运行中新建的书不在里面 → 拉回来还是旧的，下拉里永远看不到新书。
 *   所以改从 /api/worldinfo/list（POST，服务端现扫盘）拿真实清单，原地更新 world_names
 *   再重建两个下拉，索引才对得上。
 *
 * 原则：只刷 UI，不动数据；不 reloadCurrentChat（正在生成时重载会打断消息流）。
 */

import { getContext } from '../../../extensions.js';

/**
 * 懒加载酒馆的 world-info 模块。
 * 不能静态 import：world-info.js 自己有一大串依赖，静态链进来会和我们
 * extensions.js 的加载顺序打架，整包会直接加载失败（现象是面板起不来）。
 */
async function worldNamesRef() {
    try {
        const m = await import('../../../scripts/world-info.js');
        return m?.world_names || null;
    } catch {
        return null;
    }
}

/** 工具名 → 需要刷新的域 */
const DOMAINS = {
    world: ['world.', 'book.', 'wde.', 'worldbook.', 'lore.'],
    character: ['char.', 'character.', 'card.'],
    preset: ['preset.'],
    regex: ['regex.'],
    script: ['script.'],
    chat: ['chat.', 'message.', 'msg.'],
};

function domainsOf(name) {
    const n = String(name || '');
    const hit = [];
    for (const [key, prefixes] of Object.entries(DOMAINS)) {
        if (prefixes.some(p => n.startsWith(p))) hit.push(key);
    }
    return hit;
}

/** 服务端现扫 worlds 目录（POST，不能 GET） */
async function fetchWorldList() {
    const c = getContext();
    try {
        const res = await fetch('/api/worldinfo/list', {
            method: 'POST',
            headers: c.getRequestHeaders?.() || {},
            body: JSON.stringify({}),
        });
        if (!res.ok) return null;
        const data = await res.json();
        // 服务端返回的是 [{ file_id, name, extensions }]，不是 { world_names: [...] }
        if (Array.isArray(data)) {
            return data.map(x => String(x?.name ?? x?.file_id ?? '')).filter(Boolean);
        }
        return Array.isArray(data?.world_names) ? data.world_names : null;
    } catch {
        return null;
    }
}

/** 重建下拉：保留原来选中的那几个名字 */
function rebuildSelect(sel, names) {
    if (!sel) return;
    const keep = new Set(
        Array.from(sel.selectedOptions || [])
            .map(o => String(o.text || '').trim())
            .filter(Boolean),
    );
    const drop = [];
    for (const opt of Array.from(sel.options || [])) {
        if (String(opt.value || '') !== '') drop.push(opt);
    }
    drop.forEach(opt => opt.remove());

    names.forEach((name, i) => {
        // value 必须是数组下标：酒馆读取时用 world_names[value] 反查
        const opt = new Option(name, String(i));
        opt.selected = keep.has(name);
        sel.appendChild(opt);
    });
}

/** 让酒馆自己的监听器也重绘一次：手机端抽屉里的列表有时只认事件，不认直接刷新 */
async function fireEvent(name) {
    if (!name) return false;
    try {
        const m = await import('../../../script.js');
        const et = m?.event_types || {};
        const key = et[name];
        if (key && m?.eventSource?.emit) { await m.eventSource.emit(key); return true; }
    } catch { /* 老版本没有这个事件就跳过 */ }
    return false;
}

export async function refreshWorldUI() {
    const names = await fetchWorldList();
    if (!names) return { ok: false, count: 0 };

    // 原地更新酒馆模块内的 world_names（ESM 导入是只读绑定，但数组可以就地改）
    try {
        const ref = await worldNamesRef();
        if (Array.isArray(ref)) ref.splice(0, ref.length, ...names);
    } catch { /* 拿不到引用就只刷下拉 */ }

    rebuildSelect(document.getElementById('world_info'), names);
    rebuildSelect(document.getElementById('world_editor_select'), names);

    // 世界书编辑器正开着某个书 → 立刻重载它，改完的条目当场可见
    const popup = document.getElementById('world_popup_name');
    const openName = popup && popup.value ? String(popup.value).trim() : '';
    if (openName) {
        try { getContext().reloadWorldInfoEditor?.(openName, true); } catch { /* 编辑器未就绪 */ }
    }
    await fireEvent('WORLDINFO_UPDATED');
    return { ok: true, count: names.length };
}

export async function refreshCharacterUI() {
    const c = getContext();
    let ok = false;
    try {
        // getCharacters 内部会重拉 /api/characters/all、替换 characters 数组并 printCharacters(true)
        if (typeof c.getCharacters === 'function') { await c.getCharacters(); ok = true; }
    } catch (error) {
        console.warn('[st-agent] getCharacters 失败：', error && error.message);
    }
    // 兜底：再把「角色页已加载」事件发一遍，手机端抽屉里的列表靠这个重建
    await fireEvent('CHARACTER_PAGE_LOADED');
    // 真去数一遍侧栏里的卡片行——刷没刷出来，用户和我都能看见
    let rows = 0;
    try { rows = document.querySelectorAll('#rm_print_characters_block .character_select').length; } catch { rows = 0; }
    const chars = Array.isArray(c.characters) ? c.characters.length : 0;
    return { ok: ok || rows > 0, chars, rows };
}

export async function refreshPresetUI() {
    try { getContext().saveSettingsDebounced?.(); } catch { /* ignore */ }
    return { ok: true };
}

/**
 * 工具执行完之后调一次。只有写类工具（风险等级 >= 2）才需要。
 * 返回「真的刷新了什么」的明细：刷出来的写张数/本数，没刷出来的写"未同步"，
 * 这样手机端用户不用猜——工具行里直接写着同步结果。
 */
export async function refreshAfterWrite(toolName, level) {
    if (!(level >= 2)) return [];
    const domains = domainsOf(toolName);
    if (!domains.length) return [];

    const done = [];
    const jobs = {
        world: async () => {
            const r = await refreshWorldUI();
            done.push(r && r.ok ? `世界书 ${r.count} 本` : '世界书 未同步');
        },
        character: async () => {
            const r = await refreshCharacterUI();
            done.push(r && r.ok ? `角色卡 ${r.chars} 张` : '角色卡 未同步');
        },
        preset: async () => { await refreshPresetUI(); done.push('预设'); },
        regex: async () => { await refreshPresetUI(); done.push('正则'); },
        script: async () => { await refreshPresetUI(); done.push('脚本'); },
        // 聊天类不主动重载：正在生成时重载会把消息流打断
        chat: async () => { done.push('聊天'); },
    };

    for (const d of domains) {
        try {
            await jobs[d]();
        } catch (error) {
            done.push(`${d} 未同步`);
            console.warn('[st-agent] 刷新失败：', d, error && error.message);
        }
    }
    return done;
}
