import { getContext } from '../../../extensions.js';

/**
 * 酒馆内部工具集（纯前端，走 SillyTavern 自己的 /api/*，不需要服务端插件）
 * BRIDGE_TOOLS 是可选的额外能力：只有装了 st-agent-bridge 服务端插件才有。
 */

const c = () => getContext();

/* ------------------------------ 请求封装 ------------------------------ */

async function api(path, body = {}) {
    const response = await fetch(path, {
        method: 'POST',
        headers: c().getRequestHeaders(),
        body: JSON.stringify(body),
    });
    const type = response.headers.get('content-type') || '';
    const data = type.includes('json') ? await response.json().catch(() => null) : await response.text();
    if (!response.ok) {
        const detail = typeof data === 'string' ? data : JSON.stringify(data);
        throw new Error(`HTTP ${response.status} ${path}：${String(detail).slice(0, 300)}`);
    }
    return data;
}

async function apiGet(path) {
    const response = await fetch(path, { method: 'GET', headers: c().getRequestHeaders() });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
    return response.json();
}

async function apiForm(path, fields) {
    const headers = c().getRequestHeaders();
    delete headers['Content-Type'];
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;
        if (typeof value === 'object') {
            if (value instanceof Blob) form.append(key, value, value.name || 'file');
            else form.append(key, JSON.stringify(value));
        } else {
            form.append(key, String(value));
        }
    }
    const response = await fetch(path, { method: 'POST', headers, body: form });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${path}：${text.slice(0, 300)}`);
    }
    return response;
}

async function bridge(path, body = {}) {
    const response = await fetch(`/api/plugins/st-agent-bridge${path}`, {
        method: 'POST',
        headers: c().getRequestHeaders(),
        body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
    if (!json.ok) throw new Error(json.error || '桥接调用失败');
    return json.data;
}

/* ------------------------------ 小工具 ------------------------------ */

function pickCharacter(name) {
    const list = c().characters || [];
    return list.find(x => x.avatar === name) || list.find(x => x.name === name) || null;
}

function characterSummary(ch) {
    return {
        name: ch.name,
        avatar: ch.avatar,
        tags: ch.tags || [],
        creator: ch.creator || '',
        description: String(ch.description || '').slice(0, 150),
    };
}

function getSettingByPath(obj, path) {
    if (!path) return obj;
    return path.split('.').filter(Boolean).reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

async function refreshCharacters() {
    const x = c();
    try {
        const list = await api('/api/characters/all', {});
        if (Array.isArray(list)) {
            x.characters.splice(0, x.characters.length, ...list);
        }
    } catch { /* ignore */ }
}

/* ============================== 酒馆数据 ============================== */

export const ST_TOOLS = [
    {
        name: 'st.state',
        kind: 'read',
        desc: '读取当前酒馆状态：当前角色、聊天、消息数、世界书列表、模型。开局先调它。',
        params: {},
        run: async () => {
            const x = c();
            return {
                user: x.name1,
                currentCharacter: x.characters?.[x.characterId]?.name ?? null,
                currentAvatar: x.characters?.[x.characterId]?.avatar ?? null,
                chatId: x.chatId ?? null,
                messageCount: x.chat?.length ?? 0,
                groupId: x.groupId ?? null,
                characters: (x.characters || []).length,
                worldNames: x.getWorldInfoNames?.() ?? [],
                model: x.getChatCompletionModel?.() ?? null,
                maxContext: x.maxContext,
            };
        },
    },

    /* ---------------- 角色卡 ---------------- */
    {
        name: 'char.list',
        kind: 'read',
        desc: '列出全部角色卡（名称、头像文件名、标签、描述摘要）。',
        params: {},
        run: async () => (c().characters || []).map(characterSummary),
    },
    {
        name: 'char.get',
        kind: 'read',
        desc: '读取一张角色卡的完整字段（描述、性格、场景、开场白、示例对话、世界书绑定、扩展字段）。',
        params: { name: 'string 角色名或头像文件名（如 "Seraphina.png"）' },
        run: async a => {
            const ch = pickCharacter(a.name);
            if (!ch) throw new Error(`未找到角色：${a.name}`);
            const full = await api('/api/characters/get', { avatar_url: ch.avatar });
            return {
                name: full.name,
                avatar: full.avatar,
                description: full.description,
                personality: full.personality,
                scenario: full.scenario,
                first_mes: full.first_mes,
                mes_example: full.mes_example,
                creator_notes: full.creator_notes,
                system_prompt: full.system_prompt,
                post_history_instructions: full.post_history_instructions,
                alternate_greetings: full.data?.alternate_greetings,
                character_book: full.data?.character_book,
                tags: full.tags,
                creator: full.creator,
                character_version: full.character_version,
                world: full.data?.extensions?.world,
                extensions: full.data?.extensions,
            };
        },
    },
    {
        name: 'char.create',
        kind: 'write',
        desc: '新建角色卡（默认头像）。只传你要写的字段即可。',
        params: {
            name: 'string 角色名',
            description: 'string 角色描述',
            personality: 'string 性格',
            scenario: 'string 场景',
            first_mes: 'string 开场白',
            mes_example: 'string 示例对话',
            creator_notes: 'string 作者备注',
            system_prompt: 'string 系统提示',
            tags: 'array 标签',
        },
        run: async a => {
            if (!a.name) throw new Error('name 必填');
            const response = await apiForm('/api/characters/create', {
                ch_name: a.name,
                description: a.description ?? '',
                personality: a.personality ?? '',
                scenario: a.scenario ?? '',
                first_mes: a.first_mes ?? '',
                mes_example: a.mes_example ?? '',
                creator_notes: a.creator_notes ?? '',
                system_prompt: a.system_prompt ?? '',
                post_history_instructions: a.post_history_instructions ?? '',
                tags: Array.isArray(a.tags) ? a.tags.join(',') : (a.tags ?? ''),
                creator: a.creator ?? '',
                character_version: '1.0',
            });
            const avatar = await response.text();
            await refreshCharacters();
            return { ok: true, name: a.name, avatar };
        },
    },
    {
        name: 'char.edit',
        kind: 'write',
        desc: '修改角色卡字段（只传要改的字段，其余保持原样）。',
        params: {
            name: 'string 角色名或头像',
            description: 'string',
            personality: 'string',
            scenario: 'string',
            first_mes: 'string',
            mes_example: 'string',
            system_prompt: 'string',
            post_history_instructions: 'string',
            creator_notes: 'string',
            tags: 'array',
        },
        run: async a => {
            const ch = pickCharacter(a.name);
            if (!ch) throw new Error(`未找到角色：${a.name}`);
            const FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'tags', 'creator', 'character_version'];
            const changed = [];
            for (const field of FIELDS) {
                if (a[field] === undefined) continue;
                await api('/api/characters/edit-attribute', {
                    avatar_url: ch.avatar,
                    ch_name: ch.name,
                    field,
                    value: a[field],
                });
                changed.push(field);
            }
            await refreshCharacters();
            return { ok: true, avatar: ch.avatar, changed };
        },
    },
    {
        name: 'char.rename',
        kind: 'write',
        desc: '重命名角色卡。',
        params: { name: 'string 原角色名或头像', newName: 'string 新名字' },
        run: async a => {
            const ch = pickCharacter(a.name);
            if (!ch) throw new Error(`未找到角色：${a.name}`);
            await api('/api/characters/rename', { avatar_url: ch.avatar, new_name: a.newName });
            await refreshCharacters();
            return { ok: true, from: ch.name, to: a.newName };
        },
    },
    {
        name: 'char.delete',
        kind: 'dangerous',
        desc: '删除角色卡（可选择同时删除其聊天记录）。高危，执行前会请求确认。',
        params: { name: 'string 角色名或头像', deleteChats: 'boolean 是否同时删聊天记录' },
        run: async a => {
            const ch = pickCharacter(a.name);
            if (!ch) throw new Error(`未找到角色：${a.name}`);
            await api('/api/characters/delete', { avatar_url: ch.avatar, delete_chats: !!a.deleteChats });
            await refreshCharacters();
            return { ok: true, deleted: ch.name, chatsDeleted: !!a.deleteChats };
        },
    },

    /* ---------------- 世界书 ---------------- */
    {
        name: 'world.list',
        kind: 'read',
        desc: '列出全部世界书名称。',
        params: {},
        run: async () => c().getWorldInfoNames?.() ?? [],
    },
    {
        name: 'world.get',
        kind: 'read',
        desc: '读取世界书完整 JSON（entries 及 key/content/位置/概率等）。',
        params: { name: 'string 世界书名' },
        run: async a => {
            const data = await c().loadWorldInfo(a.name);
            if (!data) throw new Error(`世界书不存在：${a.name}`);
            return data;
        },
    },
    {
        name: 'world.create',
        kind: 'write',
        desc: '新建空世界书。',
        params: { name: 'string 世界书名' },
        run: async a => {
            await c().saveWorldInfo(a.name, { entries: {} }, true);
            return { ok: true, name: a.name };
        },
    },
    {
        name: 'world.save',
        kind: 'write',
        desc: '整体写入世界书 JSON（覆盖原文件并立即生效）。改之前先 world.get。',
        params: { name: 'string 世界书名', data: 'object 完整世界书对象' },
        run: async a => {
            const data = typeof a.data === 'string' ? JSON.parse(a.data) : a.data;
            if (!data || typeof data !== 'object') throw new Error('data 必须是对象');
            await c().saveWorldInfo(a.name, data, true);
            return { ok: true, name: a.name, entries: Object.keys(data.entries || {}).length };
        },
    },
    {
        name: 'world.delete',
        kind: 'dangerous',
        desc: '删除整本世界书。高危，需确认。',
        params: { name: 'string 世界书名' },
        run: async a => {
            await api('/api/worldinfo/delete', { name: a.name });
            await c().updateWorldInfoList?.();
            return { ok: true, deleted: a.name };
        },
    },
    {
        name: 'world.upsertEntry',
        kind: 'write',
        desc: '按标题新增或更新一条世界书条目；不存在则创建。',
        params: {
            name: 'string 世界书名',
            comment: 'string 条目标题',
            entry: 'object 条目字段（key/content/constant/selective/insertion_order/position...）',
        },
        run: async a => {
            const data = (await c().loadWorldInfo(a.name)) || { entries: {} };
            data.entries = data.entries || {};
            const list = Object.entries(data.entries);
            let uid = list.find(([, e]) => e.comment === a.comment)?.[0];
            const patch = typeof a.entry === 'string' ? JSON.parse(a.entry) : (a.entry || {});
            if (!uid) {
                const maxUid = list.reduce((m, [k]) => Math.max(m, Number(k) || 0), 0);
                uid = String(maxUid + 1);
            }
            data.entries[uid] = {
                uid: Number(uid),
                key: [],
                keysecondary: [],
                comment: a.comment,
                content: '',
                constant: false,
                selective: true,
                insertion_order: 100,
                enabled: true,
                position: 0,
                ...(data.entries[uid] || {}),
                ...patch,
                comment: a.comment,
            };
            await c().saveWorldInfo(a.name, data, true);
            return { ok: true, name: a.name, uid, comment: a.comment };
        },
    },
    {
        name: 'world.deleteEntry',
        kind: 'write',
        desc: '删除世界书中指定标题的条目。',
        params: { name: 'string 世界书名', comment: 'string 条目标题' },
        run: async a => {
            const data = await c().loadWorldInfo(a.name);
            if (!data) throw new Error(`世界书不存在：${a.name}`);
            const target = Object.entries(data.entries || {}).find(([, e]) => e.comment === a.comment);
            if (!target) throw new Error(`未找到条目：${a.comment}`);
            delete data.entries[target[0]];
            await c().saveWorldInfo(a.name, data, true);
            return { ok: true, name: a.name, removed: a.comment };
        },
    },

    /* ---------------- 聊天记录 ---------------- */
    {
        name: 'chat.list',
        kind: 'read',
        desc: '列出某个角色（或当前角色）的全部聊天记录文件。',
        params: { name: 'string 角色名或头像，留空用当前角色' },
        run: async a => {
            const ch = a.name ? pickCharacter(a.name) : c().characters?.[c().characterId];
            if (!ch) throw new Error('没有当前角色，请传 name');
            const data = await api('/api/characters/chats', { avatar_url: ch.avatar });
            if (Array.isArray(data)) return data;
            return data?.error ? [] : data;
        },
    },
    {
        name: 'chat.get',
        kind: 'read',
        desc: '读取指定聊天文件的消息列表。',
        params: { name: 'string 角色名或头像（留空当前）', file: 'string 聊天文件名（含 .jsonl）' },
        run: async a => {
            const ch = a.name ? pickCharacter(a.name) : c().characters?.[c().characterId];
            if (!ch) throw new Error('没有当前角色，请传 name');
            return api('/api/chats/get', { avatar_url: ch.avatar, file_name: a.file });
        },
    },
    {
        name: 'chat.search',
        kind: 'read',
        desc: '在聊天记录里搜索关键词。',
        params: { query: 'string 关键词', name: 'string 角色名或头像', limit: 'number 上限，默认 30' },
        run: async a => {
            const ch = a.name ? pickCharacter(a.name) : c().characters?.[c().characterId];
            if (!ch) throw new Error('没有当前角色，请传 name');
            const result = await api('/api/chats/search', { query: a.query, avatar_url: ch.avatar });
            const hits = Array.isArray(result) ? result : (result?.hits || []);
            return hits.slice(0, Number(a.limit) || 30);
        },
    },
    {
        name: 'chat.readCurrent',
        kind: 'read',
        desc: '读取当前打开的聊天记录（最近 N 条）。',
        params: { limit: 'number 条数，默认 30' },
        run: async a => {
            const x = c();
            const limit = Number(a.limit) || 30;
            const total = x.chat?.length ?? 0;
            return (x.chat || []).slice(-limit).map((m, i, arr) => ({
                index: total - arr.length + i,
                role: m.is_user ? 'user' : (m.name || 'char'),
                text: m.mes,
                date: m.send_date,
            }));
        },
    },
    {
        name: 'chat.append',
        kind: 'write',
        desc: '往当前聊天追加一条消息（不触发模型生成）。',
        params: { text: 'string 内容', asUser: 'boolean 是否以用户身份', name: 'string 发送者名' },
        run: async a => {
            const x = c();
            if (!x.chat) throw new Error('当前没有打开的聊天');
            x.chat.push({
                name: a.name || (a.asUser ? x.name1 : (x.characters?.[x.characterId]?.name || 'System')),
                is_user: !!a.asUser,
                is_system: false,
                send_date: new Date().toISOString(),
                mes: String(a.text ?? ''),
                extra: {},
            });
            await x.saveChatConditional?.();
            return { ok: true, messages: x.chat.length };
        },
    },
    {
        name: 'chat.editMessage',
        kind: 'write',
        desc: '按索引修改当前聊天中的一条消息。',
        params: { index: 'number 消息索引（0 基）', text: 'string 新内容' },
        run: async a => {
            const x = c();
            const msg = x.chat?.[Number(a.index)];
            if (!msg) throw new Error(`索引不存在：${a.index}`);
            msg.mes = String(a.text ?? '');
            await x.saveChatConditional?.();
            return { ok: true, index: Number(a.index), messages: x.chat.length };
        },
    },
    {
        name: 'chat.deleteMessage',
        kind: 'dangerous',
        desc: '按索引删除当前聊天中的一条消息（不可撤销，需确认）。',
        params: { index: 'number 消息索引（0 基）' },
        run: async a => {
            const x = c();
            if (!x.chat?.[Number(a.index)]) throw new Error(`索引不存在：${a.index}`);
            x.chat.splice(Number(a.index), 1);
            await x.saveChatConditional?.();
            await x.reloadCurrentChat?.();
            return { ok: true, messages: x.chat?.length };
        },
    },
    {
        name: 'chat.delete',
        kind: 'dangerous',
        desc: '删除某个聊天文件。高危，需确认。',
        params: { name: 'string 角色名或头像（留空当前）', file: 'string 聊天文件名' },
        run: async a => {
            const ch = a.name ? pickCharacter(a.name) : c().characters?.[c().characterId];
            if (!ch) throw new Error('没有当前角色，请传 name');
            await api('/api/chats/delete', { avatar_url: ch.avatar, chatfile: a.file });
            return { ok: true, deleted: a.file };
        },
    },

    /* ---------------- 设置 / 预设 / 扩展 ---------------- */
    {
        name: 'setting.get',
        kind: 'read',
        desc: '读取酒馆设置。可用 path 取单个字段（如 "power_user.context.max_context"）；不传返回精简概览。',
        params: { path: 'string 点路径，可选' },
        run: async a => {
            const all = await api('/api/settings/get', {});
            if (a.path) return getSettingByPath(all, a.path);
            const { power_user, ...rest } = all;
            return {
                keys: Object.keys(all),
                power_user: {
                    context: power_user?.context,
                    instruct: power_user?.instruct,
                    persona_name: power_user?.persona_name,
                },
                extensionSettingsKeys: Object.keys(rest.extension_settings || {}),
                world_names: rest.world_names,
            };
        },
    },
    {
        name: 'setting.set',
        kind: 'dangerous',
        desc: '按点路径修改酒馆设置并保存（会整体重写 settings.json，需确认）。',
        params: { path: 'string 点路径', value: 'any 新值' },
        run: async a => {
            const all = await api('/api/settings/get', {});
            const parts = String(a.path).split('.').filter(Boolean);
            let cursor = all;
            for (const key of parts.slice(0, -1)) {
                cursor[key] = cursor[key] ?? {};
                cursor = cursor[key];
            }
            cursor[parts[parts.length - 1]] = a.value;
            await api('/api/settings/save', all);
            return { ok: true, path: a.path };
        },
    },
    {
        name: 'preset.save',
        kind: 'write',
        desc: '保存/覆盖一个预设（apiId: openai / textgeneration / instruct / context / reasoning）。',
        params: { name: 'string 预设名', apiId: 'string 类型', preset: 'object 预设内容' },
        run: async a => {
            await api('/api/presets/save', { name: a.name, apiId: a.apiId || 'openai', preset: a.preset });
            return { ok: true, name: a.name };
        },
    },
    {
        name: 'preset.delete',
        kind: 'dangerous',
        desc: '删除一个预设。需确认。',
        params: { name: 'string 预设名', apiId: 'string' },
        run: async a => {
            await api('/api/presets/delete', { name: a.name, apiId: a.apiId || 'openai' });
            return { ok: true, deleted: a.name };
        },
    },
    {
        name: 'extension.list',
        kind: 'read',
        desc: '列出已安装扩展（系统 / 内置 / 用户 / 第三方）。',
        params: {},
        run: async () => apiGet('/api/extensions/discover'),
    },
    {
        name: 'extension.install',
        kind: 'exec',
        desc: '从 Git URL 安装扩展（需要主机已装 git）。',
        params: { url: 'string 仓库地址' },
        run: async a => {
            await api('/api/extensions/install', { url: a.url });
            return { ok: true, url: a.url, note: '刷新页面后生效' };
        },
    },
    {
        name: 'extension.delete',
        kind: 'dangerous',
        desc: '删除一个扩展目录（需确认）。',
        params: { name: 'string 扩展 id（如 third-party/xxx）' },
        run: async a => {
            await api('/api/extensions/delete', { extensionName: a.name });
            return { ok: true, deleted: a.name };
        },
    },

    /* ---------------- 正则 / 脚本 ---------------- */
    {
        name: 'regex.list',
        kind: 'read',
        desc: '列出全部正则脚本。',
        params: {},
        run: async () => (c().extensionSettings?.regex || []).map(r => ({
            scriptName: r.scriptName,
            findRegex: r.findRegex,
            replaceString: r.replaceString,
            placement: r.placement,
            disabled: r.disabled,
        })),
    },
    {
        name: 'regex.upsert',
        kind: 'write',
        desc: '按脚本名新增或更新正则脚本。',
        params: {
            scriptName: 'string 脚本名',
            findRegex: 'string 查找正则',
            replaceString: 'string 替换内容',
            placement: 'array 如 ["AI_OUTPUT","USER_INPUT"]',
            disabled: 'boolean',
        },
        run: async a => {
            const x = c();
            const list = x.extensionSettings.regex || (x.extensionSettings.regex = []);
            let item = list.find(r => r.scriptName === a.scriptName);
            if (!item) {
                item = { id: `st-agent-${Date.now()}`, scriptName: a.scriptName, findRegex: '', replaceString: '', placement: ['AI_OUTPUT'], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, substituteRegex: 0 };
                list.push(item);
            }
            Object.assign(item, {
                findRegex: a.findRegex ?? item.findRegex,
                replaceString: a.replaceString ?? item.replaceString,
                placement: a.placement ?? item.placement,
                disabled: a.disabled ?? item.disabled,
            });
            x.saveSettingsDebounced();
            return { ok: true, scriptName: a.scriptName };
        },
    },
    {
        name: 'st.command',
        kind: 'exec',
        desc: '执行 SillyTavern STscript（/send、/trigger、/world、/persona、/go、/sys 等），等于拿到酒馆全部指令。',
        params: { command: 'string 以 / 开头的脚本' },
        run: async a => {
            const result = await c().executeSlashCommandsWithOptions(a.command, { showOutput: false });
            const text = typeof result === 'string' ? result : JSON.stringify(result);
            return { ok: true, result: String(text).slice(0, 8000) };
        },
    },
    {
        name: 'ui.reload',
        kind: 'write',
        desc: '刷新酒馆前端（让直接改过的文件 / 扩展生效）。',
        params: {},
        run: async () => {
            setTimeout(() => location.reload(), 800);
            return { ok: true, note: '页面将在 1 秒后刷新' };
        },
    },
];

/* ============================== 可选：桥接能力 ============================== */

export const BRIDGE_TOOLS = [
    {
        name: 'fs.info',
        kind: 'read',
        desc: '获取酒馆根目录、用户数据目录与允许访问的根。',
        params: {},
        run: async () => (await apiGet('/api/plugins/st-agent-bridge/info')).data,
    },
    {
        name: 'fs.list',
        kind: 'read',
        desc: '列出目录（可任意层级）。',
        params: { path: 'string 目录，默认 "."', depth: 'number 1-5' },
        run: async a => bridge('/fs/list', { path: a.path ?? '.', depth: a.depth ?? 1 }),
    },
    {
        name: 'fs.read',
        kind: 'read',
        desc: '读取文本文件（带行号，支持分页）。',
        params: { path: 'string', offset: 'number', limit: 'number' },
        run: async a => bridge('/fs/read', { path: a.path, offset: a.offset ?? 0, limit: a.limit ?? 1200 }),
    },
    {
        name: 'fs.write',
        kind: 'write',
        desc: '写入/覆盖文件（自动备份）。',
        params: { path: 'string', content: 'string' },
        run: async a => bridge('/fs/write', { path: a.path, content: a.content ?? '' }),
    },
    {
        name: 'fs.edit',
        kind: 'write',
        desc: '精确替换（先 read 确认原文）。',
        params: { path: 'string', oldText: 'string', newText: 'string', replaceAll: 'boolean' },
        run: async a => bridge('/fs/edit', { path: a.path, oldText: a.oldText, newText: a.newText ?? '', replaceAll: !!a.replaceAll }),
    },
    {
        name: 'fs.copy',
        kind: 'write',
        desc: '复制文件 / 目录（备份用）。',
        params: { from: 'string', to: 'string' },
        run: async a => bridge('/fs/copy', { from: a.from, to: a.to }),
    },
    {
        name: 'fs.glob',
        kind: 'read',
        desc: 'glob 查找文件（支持 ** / * / ?）。',
        params: { pattern: 'string', cwd: 'string', limit: 'number' },
        run: async a => bridge('/fs/glob', { pattern: a.pattern, cwd: a.cwd, limit: a.limit ?? 300 }),
    },
    {
        name: 'fs.grep',
        kind: 'read',
        desc: '正则搜索文件内容。',
        params: { pattern: 'string', path: 'string', glob: 'string', limit: 'number' },
        run: async a => bridge('/fs/grep', { pattern: a.pattern, path: a.path, glob: a.glob, limit: a.limit ?? 200 }),
    },
    {
        name: 'exec',
        kind: 'exec',
        desc: '在酒馆主机执行 shell（git / npm / 脚本）。',
        params: { command: 'string', cwd: 'string' },
        run: async a => bridge('/exec', { command: a.command, cwd: a.cwd }),
    },
];

/* ------------------------------ 统一出口 ------------------------------ */

export function activeTools() {
    return window.__staBridgeOnline ? [...ST_TOOLS, ...BRIDGE_TOOLS] : ST_TOOLS;
}

export function toolByName(name) {
    return activeTools().find(t => t.name === name);
}

export function toolsPrompt() {
    return activeTools().map(t => {
        const params = Object.entries(t.params).map(([k, v]) => `    ${k}: ${v}`).join('\n');
        return `- ${t.name}${t.kind === 'dangerous' ? ' ⚠高危' : ''}\n  ${t.desc}\n${params ? '  参数:\n' + params : '  参数: 无'}`;
    }).join('\n\n');
}

/* ------------------------------ 可选工具模块（v1.4+） ------------------------------
 * 探针式加载：新工具模块按 adv-tools-vN 命名放进扩展目录即可自动挂载，
 * 不需要再改本文件、adv-tools.js 或 index.js。
 * 模块须导出 TOOLS 数组（元素结构与 ADV_TOOLS 相同）。
 */
import { ADV_TOOLS } from './adv-tools.js';

for (const mod of ['adv-tools-v14', 'adv-tools-v15', 'adv-tools-v16', 'adv-tools-v17', 'adv-tools-v18', 'adv-tools-v19']) {
    try {
        const m = await import(`./${mod}.js`);
        if (Array.isArray(m?.TOOLS)) ADV_TOOLS.push(...m.TOOLS);
    } catch { /* 模块不存在或加载失败：跳过 */ }
}
