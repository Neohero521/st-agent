import { c, api, apiGet, apiForm, bridge, pickCharacter, characterSummary, getSettingByPath, refreshCharacters } from './tools-lib.js';

export const ST_TOOLS_B = [
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
        desc: '按标题新增或更新一条世界书条目；不存在则创建。字段名与 ST 1.19 官方模板一致（order / disable / position / depth），旧名 insertion_order / enabled 会自动映射。写完记得 world.activate 才会生效。',
        params: {
            name: 'string 世界书名',
            comment: 'string 条目标题',
            entry: 'object 条目字段：key/keysecondary/content/constant/selective/order/position/disable/depth/probability/group/role/sticky/cooldown/delay/world/characterFilter...',
        },
        run: async a => {
            const TEMPLATE = {
                key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false,
                selective: true, selectiveLogic: 0, addMemo: false, order: 100, position: 0, disable: false,
                ignoreBudget: false, excludeRecursion: false, preventRecursion: false,
                matchPersonaDescription: false, matchCharacterDescription: false, matchCharacterPersonality: false,
                matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
                delayUntilRecursion: 0, probability: 100, useProbability: true, depth: 4, outletName: '',
                group: '', groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null,
                matchWholeWords: null, useGroupScoring: null, automationId: '', role: 0,
                sticky: null, cooldown: null, delay: null, triggers: [],
                characterFilter: { names: [], tags: [], isExclude: false },
            };

            if (!a.name) throw new Error('缺少 name（世界书名）');
            if (!a.comment) throw new Error('缺少 comment（条目标题）');
            const data = (await c().loadWorldInfo(a.name)) || { entries: {} };
            data.entries = data.entries || {};

            let patch = typeof a.entry === 'string' ? JSON.parse(a.entry) : (a.entry || {});
            if (patch.insertion_order !== undefined) { patch.order = patch.insertion_order; delete patch.insertion_order; }
            if (patch.enabled !== undefined) { patch.disable = !patch.enabled; delete patch.enabled; }

            const list = Object.entries(data.entries);
            const hit = list.find(([, e]) => e?.comment === a.comment);
            let key = hit?.[0];
            if (key === undefined) {
                const maxUid = list.reduce((m, [k]) => Math.max(m, Number(k) || 0), 0);
                key = String(maxUid + 1);
            }

            const base = data.entries[key] || { uid: Number(key), ...TEMPLATE };
            const merged = { ...TEMPLATE, ...base, ...patch, uid: Number(base.uid ?? key), comment: a.comment };
            data.entries[key] = merged;
            await c().saveWorldInfo(a.name, data, true);
            return {
                ok: true,
                name: a.name,
                uid: Number(key),
                comment: a.comment,
                created: !hit,
                fields: Object.keys(patch),
                order: merged.order,
                disable: merged.disable,
            };
        },
    },
    {
        name: 'world.deleteEntry',
        kind: 'write',
        desc: '删除世界书中指定标题的条目。',
        params: { name: 'string 世界书名', comment: 'string 条目标题' },
        run: async a => {
            const data = await c().loadWorldInfo(a.name);
            if (!data) throw new Error(`世界书不存在：${a.name || '未指定世界书名'}`);
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
];
