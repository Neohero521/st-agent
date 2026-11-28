/**
 * v1.4 工具层：角色卡深度合并（含 world / extensions）、批量改卡、角色导出/复制、
 * 任意聊天文件读取、新建/关闭聊天、背景与主题、触发器预演。
 *
 * 由 tools.js 末尾的探针加载器自动挂载，无需改动 index.js。
 */
import { getContext } from '../../../extensions.js';
import { fetchWithTimeout } from './adv-lib-net.js';

const c = () => getContext();
const UNSET = '__@@UNSET@@__';
const SCRIPT_PATHS = ['/script.js', '../../../../script.js', '../../../script.js'];

let scriptMod;
async function scriptModule() {
    if (scriptMod !== undefined) return scriptMod;
    for (const p of SCRIPT_PATHS) {
        try { const m = await import(p); if (m) { scriptMod = m; return m; } } catch { /* next */ }
    }
    scriptMod = null;
    return scriptMod;
}

async function postJson(url, body) {
    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { ...c().getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    return res;
}

async function readJsonOrThrow(res, what) {
    if (!res.ok) throw new Error(`${what} 失败：HTTP ${res.status}`);
    try { return await res.json(); } catch { return null; }
}

function currentAvatar() {
    const av = c().characters?.[c().characterId]?.avatar;
    if (!av) throw new Error('当前没有选中的角色卡');
    return av;
}

/* --------- 路径级 set（用于哨兵删除） --------- */

function setPath(obj, path, value) {
    const parts = String(path).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
        cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
}

/* --------- 角色卡 --------- */

async function charMerge({ avatar, fields, unset, name } = {}) {
    const av = avatar || currentAvatar();
    const payload = { avatar: av };
    if (name) payload.name = name;
    if (fields && typeof fields === 'object') Object.assign(payload, fields);
    if (Array.isArray(unset)) for (const p of unset) setPath(payload, p, UNSET);
    if (Object.keys(payload).length <= 1 && !name) throw new Error('没有要写入的字段（用 fields 或 unset）');

    const res = await postJson('/api/characters/merge-attributes', payload);
    // v1.30：手机上 merge-attributes 可能被反代/CSRF 直接 403；此时改走 edit-attribute 逐字段写
    // （ST 原生端点，body 只有 avatar_url / ch_name / field / value，权限面最小）
    if (res.status === 403) {
        const card = (c().characters || []).find(x => x.avatar === av);
        const chName = card?.name || String(av).replace(/\.png$/i, '');
        const written = [];
        for (const [k, v] of Object.entries(fields || {})) {
            if (v === UNSET) continue;
            const r2 = await postJson('/api/characters/edit-attribute', {
                avatar_url: av, ch_name: chName, field: k, value: v,
            });
            if (!r2.ok) throw new Error(`改字段 ${k} 失败：HTTP ${r2.status}`);
            written.push(k);
        }
        if (card) {
            Object.assign(card, fields);
            card.data = card.data || {};
            Object.assign(card.data, fields);
        }
        c().saveSettingsDebounced?.();
        return { ok: true, avatar: av, written, via: 'edit-attribute' };
    }
    if (res.status === 400) {
        let detail = '';
        try { const j = await res.json(); detail = j?.error || j?.message || ''; } catch { /* ignore */ }
        throw new Error(`合并失败（V2 校验未通过）：${detail || 'HTTP 400'}`);
    }
    if (!res.ok) throw new Error(`合并失败：HTTP ${res.status}`);

    // 让酒馆内存里的角色对象同步
    const local = (c().characters || []).find(x => x.avatar === av);
    if (local && fields && typeof fields === 'object') Object.assign(local, fields);
    c().saveSettingsDebounced?.();
    return { ok: true, avatar: av, written: Object.keys(fields || {}), unset: Array.isArray(unset) ? unset : [] };
}

async function charBulkMerge({ avatars, fields, filterPath, filterValue } = {}) {
    if (!fields || typeof fields !== 'object') throw new Error('需要 fields');
    const body = {
        avatars: Array.isArray(avatars) ? avatars : [],
        data: fields,
    };
    if (filterPath) {
        body.filter = { path: String(filterPath) };
        if (filterValue !== undefined) body.filter.value = filterValue;
    }
    const res = await postJson('/api/characters/merge-attributes', body);
    const json = await readJsonOrThrow(res, '批量合并');
    return { ok: true, ...(json || {}), scope: Array.isArray(avatars) && avatars.length ? `指定 ${avatars.length} 张` : '全部角色卡' };
}

async function charExportJson({ avatar, maxChars = 6000 } = {}) {
    const av = avatar || currentAvatar();
    const res = await postJson('/api/characters/export', { avatar_url: av, format: 'json' });
    if (!res.ok) throw new Error(`导出失败：HTTP ${res.status}`);
    const text = await res.text();
    let card = null;
    try { card = JSON.parse(text); } catch { /* ignore */ }
    return {
        avatar: av,
        chars: text.length,
        has_embedded_lorebook: !!card?.data?.character_book,
        card: card
            ? {
                name: card.name,
                description: (card.description || '').slice(0, maxChars),
                personality: (card.personality || '').slice(0, 400),
                scenario: (card.scenario || '').slice(0, 400),
                first_mes: (card.first_mes || '').slice(0, 600),
                tags: card.tags,
                world: card.data?.extensions?.world ?? null,
                depth_prompt: card.data?.extensions?.depth_prompt ?? null,
                extensions_keys: Object.keys(card.data?.extensions || {}),
                lorebook_entries: card.data?.character_book?.entries?.length ?? 0,
            }
            : null,
        raw_preview: text.slice(0, maxChars),
    };
}

async function charChats({ avatar, metadata = true } = {}) {
    const av = avatar || currentAvatar();
    const res = await postJson('/api/characters/chats', { avatar_url: av, metadata: !!metadata });
    const json = await readJsonOrThrow(res, '列出角色聊天');
    const list = Array.isArray(json) ? json : (json?.chats || []);
    return {
        avatar: av,
        count: list.length,
        chats: list.slice(0, 60).map(x => ({
            file_name: x.file_name,
            file_id: x.file_id,
            messages: x.chat_items ?? x.message_count ?? undefined,
            last_mes: x.last_mes ?? undefined,
            preview: (x.mes || '').slice(0, 80),
        })),
    };
}

async function charDuplicate({ avatar, newName } = {}) {
    const av = avatar || currentAvatar();
    const res = await postJson('/api/characters/duplicate', { avatar_url: av });
    if (!res.ok) throw new Error(`复制失败：HTTP ${res.status}`);
    let out = null;
    try { out = await res.json(); } catch { /* ignore */ }
    const copied = out?.avatar || out?.file_name || null;
    if (copied && newName) {
        await postJson('/api/characters/rename', { avatar_url: copied, new_name: newName }).catch(() => null);
    }
    return { ok: true, from: av, new_avatar: newName ? `${newName}.png` : copied };
}

/* --------- 聊天文件 --------- */

function parseJsonl(text) {
    const out = [];
    for (const line of String(text).split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { out.push(JSON.parse(t)); } catch { /* skip bad line */ }
    }
    return out;
}

async function chatReadFile({ file, avatar, group = false, from, to, preview = 600 } = {}) {
    if (!file) throw new Error('需要 file（聊天文件名，可先用 char.chats 或 chat.list 查）');
    const body = {
        file: String(file),
        is_group: !!group,
        format: 'jsonl',
        exportfilename: 'agent-read.jsonl',
    };
    if (!group) body.avatar_url = avatar || currentAvatar();
    const res = await postJson('/api/chats/export', body);
    if (res.status === 404) throw new Error(`找不到聊天文件：${file}`);
    const json = await readJsonOrThrow(res, '读取聊天文件');
    const raw = json?.result;
    if (typeof raw !== 'string') throw new Error('导出接口没返回 JSONL 文本');
    const lines = parseJsonl(raw);
    const total = lines.length;
    const start = from === undefined || from === null || from === '' ? 0 : Math.max(0, Number(from) < 0 ? total + Number(from) : Number(from));
    const end = to === undefined || to === null || to === '' ? total - 1 : Math.min(total - 1, Number(to) < 0 ? total + Number(to) : Number(to));
    const slice = lines.slice(start, end + 1).map((m, k) => ({
        id: start + k,
        name: m.name,
        role: m.is_user ? 'user' : (m.extra?.type === 'narrator' ? 'system' : 'assistant'),
        hidden: !!m.is_system,
        swipes: Array.isArray(m.swipes) ? m.swipes.length : 1,
        chars: (m.mes || '').length,
        text: (m.mes || '').slice(0, Number(preview) || 600),
    }));
    return { file, total, range: [start, end], count: slice.length, messages: slice };
}

async function chatNew({ deleteCurrent = false } = {}) {
    const mod = await scriptModule();
    if (!mod?.doNewChat) throw new Error('当前版本未暴露 doNewChat');
    await mod.doNewChat({ deleteCurrentChat: !!deleteCurrent });
    return { ok: true, chat_id: c().chatId || null, messages: c().chat?.length ?? 0, deleted_old: !!deleteCurrent };
}

async function chatClose() {
    const r = await c().executeSlashCommandsWithOptions?.('/closechat');
    return { ok: true, result: r?.pipe ?? null };
}

/* --------- 背景 / 主题 --------- */

async function bgList() {
    const res = await postJson('/api/backgrounds/all', {});
    const json = await readJsonOrThrow(res, '列出背景');
    const images = (json?.images || []).map(x => (typeof x === 'string' ? { filename: x } : x));
    let current = null;
    try {
        const r = await c().executeSlashCommandsWithOptions?.('/bg');
        current = r?.pipe ?? null;
    } catch { /* ignore */ }
    return { count: images.length, current, images: images.slice(0, 80) };
}

async function bgSet({ name } = {}) {
    if (!name) throw new Error('需要背景文件名（可先用 bg.list 查，支持部分名匹配）');
    const r = await c().executeSlashCommandsWithOptions?.(`/bg ${name}`);
    return { ok: true, requested: name, applied: r?.pipe ?? null };
}

async function bgDelete({ name } = {}) {
    if (!name) throw new Error('需要 bg 文件名（精确名，不是部分名）');
    const res = await postJson('/api/backgrounds/delete', { bg: name });
    if (!res.ok) throw new Error(`删除失败：HTTP ${res.status}`);
    return { ok: true, deleted: name };
}

async function themeList() {
    const res = await postJson('/api/settings/get', {});
    const json = await readJsonOrThrow(res, '读取主题列表');
    const themes = (json?.themes || []).map(t => (typeof t === 'string' ? t : t?.name || t?.filename)).filter(Boolean);
    return {
        count: themes.length,
        current: c().powerUserSettings?.theme || null,
        themes: themes.slice(0, 60),
        note: '切换主题：名称写进 powerUserSettings.theme 后刷新页面生效（酒馆没有暴露 applyTheme）',
    };
}

/* --------- 触发器预演 --------- */

function buildRegExp(pattern) {
    const s = String(pattern ?? '');
    const m = /^\/([\s\S]*)\/([gimsuy]*)$/.exec(s.trim());
    if (m) {
        try { return new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g'); } catch { return null; }
    }
    try { return new RegExp(s, 'g'); } catch { return null; }
}

function eventTest({ event = 'message_received', match = '', text = '' } = {}) {
    if (!text) throw new Error('需要 text（用来模拟一条消息）');
    const triggers = (c().extensionSettings?.['st-agent-triggers'] || []).filter(t => t.enabled !== false);
    const hits = [];
    for (const t of triggers) {
        const evName = c().eventTypes?.[String(t.event).toUpperCase()] || t.event;
        if (evName !== event && t.event !== event) continue;
        let hit = true;
        let matched = '';
        if (t.match) {
            const re = buildRegExp(t.match);
            if (re) {
                const m = re.exec(text);
                hit = !!m;
                matched = m?.[0] || '';
            } else {
                hit = text.includes(String(t.match));
                matched = hit ? String(t.match) : '';
            }
        }
        if (hit) hits.push({ id: t.id, event: t.event, matched, would_run: (t.task || '').slice(0, 120) });
    }
    return {
        text_chars: text.length, event,
        triggers_total: triggers.length,
        would_fire: hits.length,
        hits,
    };
}

/* --------- 导出 --------- */

export const TOOLS = [
    {
        name: 'char.merge', kind: 'write',
        desc: '深度合并角色卡任意字段（走 /api/characters/merge-attributes，V2 校验）。能写 edit-attribute 写不了的字段：data.extensions.world（绑定世界书）、depth_prompt、extensions 里的任意自定义字段。unset 传字段路径可删除字段。',
        params: {
            avatar: '头像文件名（默认当前角色）',
            fields: '要合并的对象，如 {data:{extensions:{world:"Eldoria"}}, description:"…"}',
            unset: '要删的字段路径数组，如 ["data.extensions.world"]',
            name: '顺便改名',
        },
        run: a => charMerge(a),
    },
    {
        name: 'char.bulkMerge', kind: 'dangerous',
        desc: '批量把同一份字段合并进多张角色卡：avatars 传头像数组，传空数组则作用于全部角色卡；filterPath 可先筛（只要该路径存在才改）。适合「给所有卡补同一个 extensions 键」「统一换绑世界书」。',
        params: { avatars: '头像数组，空数组=全部', fields: '要合并的对象', filterPath: '过滤路径，如 data.extensions.world', filterValue: '过滤值（可选）' },
        run: a => charBulkMerge(a),
    },
    {
        name: 'char.exportJson', kind: 'read',
        desc: '导出角色卡 V2 JSON（含内嵌世界书条数与 extensions 键名）。看完整卡、核对内嵌 lorebook、检查绑定世界书都用它。',
        params: { avatar: '头像文件名', maxChars: '返回文本截断长度，默认 6000' },
        run: a => charExportJson(a),
    },
    {
        name: 'char.chats', kind: 'read',
        desc: '列出某个角色卡下的所有聊天文件（比 chat.list 精准，支持任意角色，不用先切过去）。',
        params: { avatar: '头像文件名', metadata: '是否带楼层数/最后一条预览，默认 true' },
        run: a => charChats(a),
    },
    {
        name: 'char.duplicate', kind: 'write',
        desc: '复制角色卡（含头像），可选顺便改名。',
        params: { avatar: '要复制的头像', newName: '新卡名（不含 .png）' },
        run: a => charDuplicate(a),
    },
    {
        name: 'chat.readFile', kind: 'read',
        desc: '读取任意聊天文件的完整楼层（走 /api/chats/export 的 jsonl 短路径），不限于当前打开的那一档。这是「查内部聊天文件」的直连通道。',
        params: {
            file: '聊天文件名（char.chats / chat.list 可查）',
            avatar: '角色头像（非群聊时必填，默认当前角色）',
            group: '是否群聊聊天文件',
            from: '起始楼层（可负数）',
            to: '结束楼层（可负数）',
            preview: '每楼正文截断长度，默认 600',
        },
        run: a => chatReadFile(a),
    },
    {
        name: 'chat.new', kind: 'write',
        desc: '开一档新聊天（等同 UI 的「新聊天」）。deleteCurrent=true 会先把当前这档删掉。',
        params: { deleteCurrent: '是否删除当前聊天，默认 false' },
        run: a => chatNew(a),
    },
    {
        name: 'chat.close', kind: 'write',
        desc: '关闭当前聊天（回到角色选择态）。',
        params: {},
        run: () => chatClose(),
    },
    {
        name: 'bg.list', kind: 'read',
        desc: '列出酒馆背景图片（含是否动图）以及当前正在用的背景。',
        params: {},
        run: () => bgList(),
    },
    {
        name: 'bg.set', kind: 'write',
        desc: '切换聊天背景（等同 /bg，支持部分名匹配）。',
        params: { name: '背景文件名，可只写一部分' },
        run: a => bgSet(a),
    },
    {
        name: 'bg.delete', kind: 'dangerous',
        desc: '删除一张背景图片（要精确文件名）。',
        params: { name: '背景文件名' },
        run: a => bgDelete(a),
    },
    {
        name: 'theme.list', kind: 'read',
        desc: '列出已安装的主题（UI 主题 JSON）与当前主题名。',
        params: {},
        run: () => themeList(),
    },
    {
        name: 'event.test', kind: 'read',
        desc: '预演触发器：给一段模拟消息，看哪些已挂的触发器会命中、会跑什么任务。挂触发器前先用它验证 match 写得对不对，避免误触发烧额度。',
        params: { event: '事件名，默认 message_received', match: '可选，额外测一个匹配式', text: '模拟消息正文' },
        run: a => eventTest(a),
    },
];
