import { c, api, apiGet, apiForm, bridge, pickCharacter, characterSummary, getSettingByPath, refreshCharacters } from './tools-lib.js';
import { writeCardExtensions } from './adv-lib-card.js';
import { fetchWithTimeout } from './adv-lib-net.js';

export const ST_TOOLS_A = [
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
            if (!ch) throw new Error(`未找到角色：${a.name || '当前没有选中的角色'}`);
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
        desc: '修改角色卡字段（只传要改的字段）。走 /api/characters/merge-attributes：一次请求写多个字段、深合并、支持 extensions 嵌套，并对顶层与 data 同时写入（V2 卡读的是 data，只写顶层看起来「没改」）。',
        params: {
            name: 'string 角色名或头像（只用于定位角色，不会改卡名）',
            cardName: 'string 要改成的角色卡名字（改名用这个）',
            description: 'string',
            personality: 'string',
            scenario: 'string',
            first_mes: 'string',
            mes_example: 'string',
            system_prompt: 'string',
            post_history_instructions: 'string',
            creator_notes: 'string',
            creator: 'string',
            character_version: 'string',
            tags: 'array 或逗号分隔字符串',
            world: 'string 绑定世界书名（写 data.extensions.world）',
            talkativeness: 'number 话痨度',
            depth_prompt: 'object {prompt, depth, role} 作者注释',
            extensions: 'object 任意扩展字段，深合并',
            unset: 'array 要删除的字段路径，如 ["depth_prompt.prompt"]',
        },
        run: async a => {
            const ch = pickCharacter(a.name);
            if (!ch) throw new Error(`未找到角色：${a.name || '当前没有选中的角色'}`);

            const TEXT = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes',
                'system_prompt', 'post_history_instructions', 'creator', 'character_version', 'creatorcomment'];
            const patch = {};
            const dataPatch = {};
            const changed = [];

            for (const field of TEXT) {
                if (a[field] === undefined) continue;
                patch[field] = a[field];
                dataPatch[field] = a[field];
                changed.push(field);
            }

            if (a.cardName !== undefined) {
                patch.name = a.cardName;
                dataPatch.name = a.cardName;
                changed.push('cardName');
            }

            if (a.tags !== undefined) {
                const tags = Array.isArray(a.tags)
                    ? a.tags
                    : String(a.tags).split(',').map(s => s.trim()).filter(Boolean);
                patch.tags = tags;
                dataPatch.tags = tags;
                changed.push('tags');
            }

            if (a.world !== undefined) {
                dataPatch.extensions = { ...(dataPatch.extensions || {}), world: a.world };
                changed.push('world');
            }
            if (a.talkativeness !== undefined) {
                const value = Number(a.talkativeness);
                patch.talkativeness = value;
                dataPatch.extensions = { ...(dataPatch.extensions || {}), talkativeness: value };
                changed.push('talkativeness');
            }
            if (a.depth_prompt !== undefined && typeof a.depth_prompt === 'object') {
                patch.depth_prompt = a.depth_prompt;
                dataPatch.depth_prompt = a.depth_prompt;
                changed.push('depth_prompt');
            }
            if (a.extensions !== undefined && typeof a.extensions === 'object') {
                dataPatch.extensions = { ...(dataPatch.extensions || {}), ...a.extensions };
                changed.push('extensions');
            }
            if (Array.isArray(a.unset) && a.unset.length) {
                for (const path of a.unset) {
                    const parts = String(path).split('.');
                    const apply = obj => {
                        let cur = obj;
                        for (let i = 0; i < parts.length - 1; i++) {
                            if (!cur || typeof cur !== 'object') return;
                            cur = cur[parts[i]];
                        }
                        if (cur && typeof cur === 'object') cur[parts.at(-1)] = '__@@UNSET@@__';
                    };
                    apply(patch);
                    apply(dataPatch);
                    changed.push(`unset:${path}`);
                }
            }

            if (!changed.length) return { ok: true, avatar: ch.avatar, changed: [] };

            const res = await fetchWithTimeout('/api/characters/merge-attributes', {
                method: 'POST',
                headers: c().getRequestHeaders(),
                body: JSON.stringify({ avatar: ch.avatar, ...patch, data: dataPatch }),
            });
            if (res.status === 403) {
                // v1.30：merge-attributes 被拒（反代/CSRF）→ edit-attribute 逐字段 + 统一 extensions 通道
                const done = [];
                const chName = ch.name || String(ch.avatar).replace(/\.png$/i, '');
                const top = Object.keys(patch).filter(k => k !== 'data');
                for (const k of top) {
                    if (patch[k] === undefined) continue;
                    const r2 = await fetchWithTimeout('/api/characters/edit-attribute', {
                        method: 'POST',
                        headers: c().getRequestHeaders(),
                        body: JSON.stringify({ avatar_url: ch.avatar, ch_name: chName, field: k, value: patch[k] }),
                    });
                    if (!r2.ok) throw new Error(`改字段 ${k} 失败：HTTP ${r2.status}`);
                    done.push(k);
                }
                if (dataPatch.extensions && typeof dataPatch.extensions === 'object') {
                    await writeCardExtensions(ch.avatar, ext => Object.assign({}, ext, dataPatch.extensions));
                    if (!done.includes('extensions')) done.push('extensions');
                }
                await refreshCharacters();
                return { ok: true, avatar: ch.avatar, changed: done, via: 'edit-attribute' };
            }
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.message || `合并角色卡失败 HTTP ${res.status}`);
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
            if (!ch) throw new Error(`未找到角色：${a.name || '当前没有选中的角色'}`);
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
            if (!ch) throw new Error(`未找到角色：${a.name || '当前没有选中的角色'}`);
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
            if (!data) throw new Error(`世界书不存在：${a.name || '未指定世界书名'}`);
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
];
