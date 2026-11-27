import { getContext } from '../../../extensions.js';

/**
 * 角色卡「正则位」（scoped regex）读写。
 *
 * 为什么非要有这个文件：ST 的正则有三个作用域，数据完全不在一个地方——
 *   GLOBAL   → extension_settings.regex（全剧通用）
 *   SCOPED   → characters[chid].data.extensions.regex_scripts（跟着这张卡走）
 *   PRESET   → 预设的 regex_scripts
 * 而且 SCOPED 还多一道闸：extension_settings.character_allowed_regex 里必须有这张卡的 avatar，
 * 否则引擎 getScriptsByType(SCOPED, {allowedOnly:true}) 直接返回空数组——正则静静躺在卡里、
 * 界面上也能看到，就是一个字都不生效。这是「给某张卡做的正则，怎么都不起作用」最常见的原因。
 *
 * 之前 regex.upsert / mvu.statusbar 只往 extension_settings.regex 写，于是：
 *   给 A 卡做的状态栏正则，跑去 B 卡、C 卡也生效；
 *   用户打开角色卡的正则页（Scoped 页签）一片空白，以为没写成功；
 *   同一张卡换一份干净存档，正则跟着全局走，串戏。
 * v1.23 起：默认写卡，卡级写入同时自动开闸。
 */

export function charBy(avatar) {
    const ctx = getContext();
    const av = avatar === undefined || avatar === null || avatar === '' ? ctx.characterId : avatar;
    if (av === undefined || av === null || av === '') return null;
    const list = Array.isArray(ctx.characters) ? ctx.characters : [];
    return list.find(x => x && x.avatar === av) || null;
}

export function scopedScripts(ch) {
    const list = ch && ch.data && ch.data.extensions ? ch.data.extensions.regex_scripts : null;
    return Array.isArray(list) ? list : [];
}

/** 这张卡的正则位是否已被允许（character_allowed_regex 里有它的 avatar） */
export function scopedAllowed(ch) {
    if (!ch) return false;
    const ctx = getContext();
    const allow = ctx.extensionSettings ? ctx.extensionSettings.character_allowed_regex : null;
    return Array.isArray(allow) && allow.includes(ch.avatar);
}

/** 开闸：把 avatar 记进 character_allowed_regex。不开闸，scoped 正则一律不跑 */
export function allowScoped(ch) {
    if (!ch) return false;
    const ctx = getContext();
    ctx.extensionSettings = ctx.extensionSettings || {};
    const allow = Array.isArray(ctx.extensionSettings.character_allowed_regex)
        ? ctx.extensionSettings.character_allowed_regex
        : (ctx.extensionSettings.character_allowed_regex = []);
    if (allow.includes(ch.avatar)) return false;
    allow.push(ch.avatar);
    ctx.saveSettingsDebounced?.();
    return true;
}

/** 把正则数组写回卡里（走官方同一条通道：merge-attributes 只 merge 这一个 key） */
export async function saveScoped(ch, list) {
    if (!ch) throw new Error('没有目标角色卡：scoped 正则必须挂在某张卡上');
    ch.data = ch.data || {};
    ch.data.extensions = ch.data.extensions || {};
    ch.data.extensions.regex_scripts = list;

    // V2 原始 JSON 也要同步，否则「保存当前角色」时旧 json_data 会把这批正则覆盖掉
    if (ch.json_data) {
        try {
            const raw = JSON.parse(ch.json_data);
            raw.data = raw.data || {};
            raw.data.extensions = raw.data.extensions || {};
            raw.data.extensions.regex_scripts = list;
            ch.json_data = JSON.stringify(raw);
        } catch { /* 卡本身不是合法 JSON 就跳过，不阻断 */ }
    }

    const res = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar: ch.avatar, data: { extensions: { regex_scripts: list } } }),
    });
    if (!res.ok) throw new Error(`写入角色卡正则位失败：HTTP ${res.status}`);
    return { avatar: ch.avatar, total: list.length };
}

/**
 * 在卡里按 scriptName（其次 id）判重后 upsert。
 * 与全局那条 regex.upsert 的字段完全一致，免得同一个正则换个作用域就少字段。
 */
export async function upsertScoped(ch, script) {
    if (!ch) throw new Error('没有目标角色卡：scoped 正则必须挂在某张卡上');
    const list = scopedScripts(ch).slice();
    const base = Object.assign({
        id: `st-agent-${Date.now()}`,
        scriptName: '',
        findRegex: '',
        replaceString: '',
        placement: [2],
        disabled: false,
        markdownOnly: false,
        promptOnly: false,
        runOnEdit: false,
        substituteRegex: 0,
    }, script);
    const idx = list.findIndex(r => r && ((base.id && r.id === base.id) || (base.scriptName && r.scriptName === base.scriptName)));
    const created = idx < 0;
    if (created) list.push(base);
    else list[idx] = Object.assign({}, list[idx], script);
    await saveScoped(ch, list);
    const opened = allowScoped(ch);
    return { created, opened, avatar: ch.avatar, total: list.length, item: list[created ? list.length - 1 : idx] };
}

/** 全局 + 卡内两张表合起来看（审计、列表用） */
export function allRegexes(ch) {
    const ctx = getContext();
    const global = Array.isArray(ctx.extensionSettings?.regex) ? ctx.extensionSettings.regex : [];
    return [
        ...global.map(r => ({ scope: 'global', ...r })),
        ...scopedScripts(ch).map(r => ({ scope: 'scoped', character: ch.avatar, ...r })),
    ];
}
