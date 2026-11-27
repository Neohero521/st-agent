/**
 * v1.11 工具层：把「写完能看见效果」这条链补全。
 *
 * 逐个核对 SillyTavern 1.19.1 源码后确认的写入路径（见 docs/v1.11-write-paths.md）：
 *   - 世界书条目：内存改 entries → saveWorldInfo(name, data, true) → POST /api/worldinfo/edit（整本原子写）
 *     写完必须「激活」，否则用户拿不到效果。激活有三档：
 *       global    → power_user.world_info.globalSelect（全局书单）
 *       chat      → chat_metadata.world_info（当前聊天绑定）
 *       character → 角色卡 data.extensions.world（随卡走）
 *   - 酒馆助手脚本：必须走 TavernHelper.getScriptTrees({type}) / replaceScriptTrees(trees, {type})，
 *     且 Script 结构是 {type:'script', enabled, name, id, content, info, button:{enabled,buttons}, data, export_with}。
 *     字段是 content 不是 code；id 必须保留，否则 iframe runtime 与按钮绑定全断（旧实现的两个硬 bug）。
 *   - 正则：extension_settings.regex + saveSettingsDebounced()（与官方 regex 扩展 engine.js 一致）。
 *   - 预设：POST /api/presets/save {name, apiId, preset}（官方 v1.19 端点）。
 */
import { getContext } from '../../../extensions.js';

const c = () => getContext();

const SCRIPT_SCOPES = ['global', 'preset', 'character'];
const TEXT_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes',
    'system_prompt', 'post_history_instructions', 'creator', 'character_version', 'creatorcomment'];

function th() {
    return globalThis.TavernHelper || window.TavernHelper || null;
}

function needRunner() {
    const h = th();
    if (!h?.getScriptTrees || !h?.replaceScriptTrees) throw new Error('需要「酒馆助手」(JS-Slash-Runner) 4.x');
    return h;
}

function treeOf(h, scope) {
    const opt = { type: scope };
    try { return h.getScriptTrees(opt) || []; } catch { return h.getScriptTrees() || []; }
}

function pushTree(h, trees, scope) {
    try { h.replaceScriptTrees(trees, { type: scope }); } catch { h.replaceScriptTrees(trees); }
}

function walkScripts(trees, fn) {
    return trees.map(t => {
        if (t?.type === 'folder') return { ...t, scripts: (t.scripts || []).map(s => fn(s)) };
        return fn(t);
    });
}

function newId() {
    return globalThis.crypto?.randomUUID?.() ?? `st-agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function characterBy(a) {
    const list = c().characters ?? [];
    if (!a?.name) return list[c().characterId] || null;
    const key = String(a.name);
    return list.find(ch => ch.avatar === key || ch.avatar === `${key}.png` || ch.name === key) || null;
}

async function readonlyWorld(name) {
    const data = await c().loadWorldInfo(name);
    if (!data) throw new Error(`世界书不存在：${name || '未指定世界书名'}`);
    return data;
}

/* ------------------------------ 世界书激活 ------------------------------ */

async function worldExists(ctx, name) {
    // 权威判定：/api/worldinfo/list 直读磁盘文件名，不依赖前端缓存。
    try {
        const r = await fetch('/api/worldinfo/list', { method: 'POST', headers: ctx.getRequestHeaders(), body: '{}' });
        if (r.ok) {
            const list = await r.json();
            if (Array.isArray(list) && list.length) {
                return list.some(f => f?.file_id === name || f?.name === name);
            }
        }
    } catch { /* 端点不可用则退回内存名单 */ }
    const names = ctx.getWorldInfoNames?.() ?? ctx.world_names ?? [];
    return Array.isArray(names) && names.length ? names.includes(name) : true;
}

async function activateWorld({ name, scope = 'chat', value = true, char } = {}) {
    if (!name) throw new Error('需要 name（世界书名）');
    const charName = char;
    const ctx = c();
    if (!(await worldExists(ctx, name))) {
        throw new Error(`世界书不存在：${name}（可用 world.list 查看）`);
    }
    // 新建的书在前端缓存里往往还没有：拉一次列表把 world_names 与下拉框补上，
    // 否则用户切到世界书面板会看不到这本书。
    try { await ctx.updateWorldInfoList?.(); } catch { /* UI 未就绪时忽略 */ }
    const done = { ok: true, name, scope, active: !!value };

    if (scope === 'global') {
        const pu = c().power_user || {};
        pu.world_info = pu.world_info || {};
        const list = Array.isArray(pu.world_info.globalSelect) ? pu.world_info.globalSelect : [];
        pu.world_info.globalSelect = value
            ? [...list.filter(x => x !== name), name]
            : list.filter(x => x !== name);
        c().saveSettingsDebounced?.();
        try {
            const el = document.querySelector('#world_info');
            const ts = el?.tomselect;
            if (ts) { value ? ts.addItem(name) : ts.removeItem(name); }
            else if (el) { el.value = pu.world_info.globalSelect.join(','); }
        } catch { /* UI 同步失败不影响落盘 */ }
        done.list = pu.world_info.globalSelect;
        return done;
    }

    if (scope === 'chat') {
        const meta = c().chatMetadata || (c().chatMetadata = {});
        meta.world_info = value ? name : '';
        (c().saveMetadata?.() ?? c().saveMetadataDebounced?.());
        return done;
    }

    if (scope === 'character') {
        const target = await characterBy({ name: charName });
        if (!target) throw new Error(`未找到角色：${charName || '（当前）'}`);
        const res = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: c().getRequestHeaders(),
            body: JSON.stringify({
                avatar: target.avatar,
                data: { extensions: { world: value ? name : '' } },
            }),
        });
        if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error(j.message || `合并角色卡失败 HTTP ${res.status}`);
        }
        // 与官方 world-info.js 同款收尾：merge 只改了磁盘，浏览器内存还是旧卡，
        // 不重新拉一次，用户在当前会话里会一直看到旧绑定、以为没写进去。
        if (typeof ctx.getOneCharacter === 'function') {
            try { await ctx.getOneCharacter(target.avatar); } catch { /* 拉取失败则退回直接改内存 */ }
        }
        const fresh = (c().characters || []).find(ch => ch.avatar === target.avatar);
        if (fresh) {
            fresh.data = fresh.data || {};
            fresh.data.extensions = fresh.data.extensions || {};
            fresh.data.extensions.world = value ? name : '';
        }
        done.avatar = target.avatar;
        done.synced = true;
        return done;
    }

    throw new Error('scope 只能是 global / chat / character');
}

/* ------------------------------ 新增工具 ------------------------------ */

export const TOOLS = [
    {
        name: 'world.activate',
        kind: 'write',
        desc: '把世界书「激活」到 global（全局书单）/ chat（当前聊天）/ character（当前角色卡），写完条目必须激活才生效。',
        params: { name: '世界书名', scope: 'global / chat / character，默认 chat', value: 'true 绑定，false 解绑', char: 'scope=character 时可指定角色名/头像，留空用当前' },
        run: a => activateWorld(a),
    },
    {
        name: 'world.getEntry',
        kind: 'read',
        desc: '读一条世界书条目的全部字段（核对 order / disable / position / depth 是否真的写进去了）。',
        params: { name: '世界书名', comment: '条目标题；也可传 uid' },
        run: async a => {
            const data = await readonlyWorld(a.name);
            const entries = Object.entries(data.entries || {});
            const hit = a.uid !== undefined
                ? entries.find(([k]) => String(k) === String(a.uid))
                : entries.find(([, e]) => e?.comment === a.comment);
            if (!hit) throw new Error(`未找到条目：${a.comment ?? a.uid ?? '未指定标题或 uid'}`);
            return { ok: true, uid: hit[0], entry: hit[1] };
        },
    },
    {
        name: 'script.get',
        kind: 'read',
        desc: '读「酒馆助手」里某个脚本的原文与结构（content / enabled / button / id），用来确认脚本真的写进去了。',
        params: { name: '脚本名', scope: 'global / preset / character，默认 global' },
        run: a => {
            const h = needRunner();
            const trees = treeOf(h, a.scope || 'global');
            let found = null;
            walkScripts(trees, t => { if (t?.name === a.name) found = t; return t; });
            if (!found) throw new Error(`未找到脚本：${a.name || '未指定脚本名'}`);
            return { ok: true, script: found, length: String(found.content || '').length };
        },
    },
    {
        name: 'script.delete',
        kind: 'write',
        desc: '从「酒馆助手」删除脚本（支持文件夹内的脚本；scope 同 script.get）。',
        params: { name: '脚本名', scope: 'global / preset / character，默认 global' },
        run: a => {
            const h = needRunner();
            const scope = a.scope || 'global';
            const trees = treeOf(h, scope);
            let removed = false;
            const next = trees
                .filter(t => {
                    if (t?.type !== 'folder' && t?.name === a.name) { removed = true; return false; }
                    return true;
                })
                .map(t => t?.type === 'folder'
                    ? { ...t, scripts: (t.scripts || []).filter(s => { if (s?.name === a.name) { removed = true; return false; } return true; }) }
                    : t);
            if (!removed) throw new Error(`未找到脚本：${a.name || '未指定脚本名'}`);
            pushTree(h, next, scope);
            return { ok: true, name: a.name, scope };
        },
    },
    {
        name: 'regex.delete',
        kind: 'write',
        desc: '删除一条正则脚本（extension_settings.regex + saveSettingsDebounced，与官方正则扩展一致）。',
        params: { scriptName: '正则脚本名' },
        run: a => {
            if (!a.scriptName) throw new Error('需要 scriptName');
            const x = c();
            const list = x.extensionSettings.regex || [];
            const idx = list.findIndex(r => r.scriptName === a.scriptName);
            if (idx < 0) throw new Error(`未找到正则：${a.scriptName}`);
            list.splice(idx, 1);
            x.saveSettingsDebounced();
            return { ok: true, removed: a.scriptName, total: list.length };
        },
    },
    {
        name: 'char.fields',
        kind: 'read',
        desc: '列出一个角色卡实际有哪些字段（顶层 / data 两套），写之前先确认字段名与是否存在。',
        params: { name: '角色名或头像，留空用当前' },
        run: async a => {
            const ch = await characterBy(a);
            if (!ch) throw new Error('未找到角色');
            const top = Object.keys(ch).sort();
            const dataKeys = ch.data && typeof ch.data === 'object' ? Object.keys(ch.data).sort() : [];
            return {
                ok: true,
                avatar: ch.avatar,
                name: ch.name,
                top,
                data: dataKeys,
                extensions: Object.keys(ch.data?.extensions || {}).sort(),
                boundWorld: ch.data?.extensions?.world || '',
                tags: Array.isArray(ch.tags) ? ch.tags : (ch.data?.tags ?? []),
            };
        },
    },
];

export const __TEXT_FIELDS = TEXT_FIELDS;
