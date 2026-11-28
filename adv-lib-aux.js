import { getContext } from '../../../extensions.js';
import { c, participants, indexOfId, roleOf, msgVars, parseValue, stringifyValue, persistChat, refreshMessage, varStore, readVar, writeVar, deleteVar, describeMessage, getMessages, setMessage, createMessage, deleteMessages, swipeMessage } from './adv-lib-core.js';
import { entryFields, loadBook, getEntries, setEntry, deleteEntry, bindChatBook, POSITIONS, ROLES, setInject, clearInject, listInject } from './adv-lib-world.js';
import { allRegexes, buildRegExp, testRegex, setRegexEnabled, loadPreset, listPresets, setPersona, helper, helperInfo, listScripts, setScript, scriptMod, getScriptModule } from './adv-lib-ext.js';
import { fetchWithTimeout } from './adv-lib-net.js';

export async function branchChatAt({ id = -1 } = {}) {
    const index = indexOfId(id);
    let mod;
    for (const path of ['/scripts/bookmarks.js', '../../../../scripts/bookmarks.js']) {
        try { mod = await import(path); break; } catch { /* try next */ }
    }
    if (!mod?.branchChat) throw new Error('当前酒馆版本未暴露 branchChat（需要 1.12+）');
    const name = await mod.branchChat(index, {});
    return { ok: !!name, from_message: index, new_chat: name || null };
}

export function renameChatTo({ name } = {}) {
    if (!name) throw new Error('需要新聊天名');
    if (!c().chatId) throw new Error('当前没有打开的聊天');
    c().renameChat?.(name);
    return { ok: true, old: c().chatId, note: 'renameChat 由酒馆内部完成，新名以 UI 为准' };
}

/* --- 事件触发器：让 Agent 能"盯着"酒馆，被动变主动 --- */

export const attachedTriggers = new Map();

export function triggerList() {
    try {
        const es = c().extensionSettings;
        if (!Array.isArray(es['st-agent-triggers'])) es['st-agent-triggers'] = [];
        return es['st-agent-triggers'];
    } catch {
        return [];
    }
}

export function detachTrigger(id) {
    const item = attachedTriggers.get(id);
    if (!item) return false;
    try { c().eventSource?.removeListener?.(item.event, item.handler); } catch { /* ignore */ }
    attachedTriggers.delete(id);
    return true;
}

export function attachTrigger(t) {
    if (!t?.id || !t?.event) return;
    detachTrigger(t.id);
    const types = c().eventTypes || {};
    const eventName = types[String(t.event).toUpperCase()] || t.event;
    const source = c().eventSource;
    if (!source) throw new Error('当前版本没有 eventSource');
    const handler = async data => {
        try {
            let text = '';
            if (typeof data === 'number') text = c().chat?.[data]?.mes || '';
            else if (typeof data === 'string') text = data;
            else text = String(data ?? '');
            if (!text) return;
            if (t.match) {
                const re = buildRegExp(t.match);
                const hit = re ? re.test(text) : text.includes(String(t.match));
                if (!hit) return;
            }
            await globalThis.STAgent?.run?.(t.task ? t.task.replace('{text}', text.slice(0, 2000)) : `处理这条新消息：${text.slice(0, 800)}`);
        } catch (error) {
            console.warn('[st-agent] 触发器执行失败：', error);
        }
    };
    source.on(eventName, handler);
    attachedTriggers.set(t.id, { event: eventName, handler });
}

export function addTrigger({ id, event = 'message_received', match = '', task = '' } = {}) {
    const rid = id || `trg_${Date.now()}`;
    const list = triggerList();
    const item = { id: rid, event, match, task, enabled: true };
    const i = list.findIndex(x => x.id === rid);
    if (i >= 0) list[i] = item;
    else list.push(item);
    c().saveSettingsDebounced?.();
    attachTrigger(item);
    return { ok: true, ...item };
}

export function removeTrigger({ id } = {}) {
    if (!id) throw new Error('需要触发器 id');
    const list = triggerList();
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return { ok: false, reason: `没有 id=${id} 的触发器` };
    list.splice(i, 1);
    c().saveSettingsDebounced?.();
    const detached = detachTrigger(id);
    return { ok: true, removed: id, detached };
}

export function listTriggers() {
    const list = triggerList();
    const types = Object.keys(c().eventTypes || {}).sort();
    return {
        count: list.length,
        triggers: list.map(t => ({ ...t, attached: attachedTriggers.has(t.id) })),
        usable_events: types.slice(0, 40),
    };
}

/* --- 人格 --- */

export function personaAvatar(name) {
    // power_user.personas: { avatar文件名: 显示名 }
    const pu = c().powerUserSettings || {};
    const pair = Object.entries(pu.personas || {}).find(([, n]) => n === name);
    return pair ? pair[0] : null;
}

export function listPersonas() {
    const pu = c().powerUserSettings || {};
    const descs = pu.persona_descriptions || {};
    const current = c().name1;
    return {
        current,
        count: Object.keys(pu.personas || {}).length,
        personas: Object.entries(pu.personas || {}).map(([avatar, name]) => ({
            name,
            avatar,
            current: name === current,
            description: (descs[avatar]?.description || '').slice(0, 200),
            position: descs[avatar]?.position,
            depth: descs[avatar]?.depth,
            role: descs[avatar]?.role,
        })),
        global_description: (pu.persona_description || '').slice(0, 200),
    };
}

export function setPersonaDesc({ text, name, position, depth, role } = {}) {
    const pu = c().powerUserSettings;
    if (!pu) throw new Error('当前版本没有 powerUserSettings');
    const targetName = name || c().name1;
    const avatar = personaAvatar(targetName);
    pu.personas = pu.personas || {};
    pu.persona_descriptions = pu.persona_descriptions || {};
    if (avatar) {
        const item = pu.persona_descriptions[avatar] || {};
        if (text !== undefined) item.description = String(text ?? '');
        if (position !== undefined) item.position = Number(position);
        if (depth !== undefined) item.depth = Number(depth);
        if (role !== undefined) item.role = Number(role);
        pu.persona_descriptions[avatar] = item;
        if (targetName === c().name1 && text !== undefined) pu.persona_description = String(text ?? '');
        c().saveSettingsDebounced?.();
        return { ok: true, persona: targetName, avatar, scope: 'persona', chars: (item.description || '').length };
    }
    if (text === undefined) throw new Error(`找不到人格「${targetName}」的 avatar，且没传 text`);
    pu.persona_description = String(text ?? '');
    c().saveSettingsDebounced?.();
    return { ok: true, persona: targetName, scope: 'global', chars: pu.persona_description.length };
}

export async function switchPersona({ name } = {}) {
    if (!name) throw new Error('需要人格名');
    if (!personaAvatar(name)) throw new Error(`没有名为「${name}」的人格`);
    const mod = await getScriptModule();
    if (!mod?.setUserName) throw new Error('当前版本未暴露 setUserName');
    await mod.setUserName(name);
    return { ok: true, user: c().name1 };
}

/* --- 群聊 --- */

export function listGroups() {
    const groups = c().groups || [];
    return {
        current: c().groupId || null,
        count: groups.length,
        groups: groups.map(g => ({
            id: g.id,
            name: g.name,
            members: (g.members || []).length,
            disabled: !!g.disabled,
            chat_id: g.chat_id || null,
        })),
    };
}

export async function activateGroup({ id, name } = {}) {
    const groups = c().groups || [];
    const g = groups.find(x => String(x.id) === String(id)) || groups.find(x => x.name === name);
    if (!g) throw new Error('找不到该群聊，先用 group.list 查 id');
    if (!g.chat_id) throw new Error(`群聊「${g.name}」还没有聊天文件，请先在 UI 里打开一次`);
    await c().openGroupChat(g.id, g.chat_id);
    return { ok: true, group: g.name, chat: g.chat_id };
}

/* --- 杂项 --- */

export async function countTokens({ text } = {}) {
    if (text === undefined) throw new Error('需要 text');
    const n = await c().getTokenCountAsync?.(String(text));
    if (n === undefined || n === null) throw new Error('当前版本没有 getTokenCountAsync');
    return { tokens: n, chars: String(text).length };
}

export function expandMacros({ text } = {}) {
    if (text === undefined) throw new Error('需要 text');
    const out = c().substituteParams?.(String(text));
    if (out === undefined) throw new Error('当前版本没有 substituteParams');
    return { input: String(text), output: String(out) };
}

export function genInfo() {
    return {
        main_api: c().mainApi,
        model: (() => { try { return c().getChatCompletionModel?.() || null; } catch { return null; } })(),
        max_context: c().maxContext,
        chat: c().chatId || null,
        messages: c().chat?.length ?? 0,
    };
}

export async function stopGen() {
    try {
        await c().stopGeneration?.();
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: error.message };
    }
}

export async function setGlobalBook({ name } = {}) {
    if (!name) throw new Error('需要世界书名字');
    if (!c().getWorldInfoNames?.().includes(name)) throw new Error(`世界书「${name}」不存在`);
    const r = await c().executeSlashCommandsWithOptions?.(`/world ${name}`);
    return { ok: true, global_book: name, result: r?.pipe ?? null };
}

/* ------------------------------ v1.3：快速回复 / 全库检索 / 独立生成 / 采样器 ------------------------------ */

export function qrApi() {
    const api = globalThis.quickReplyApi;
    if (!api) throw new Error('没找到 quickReplyApi（酒馆「快速回复」扩展未启用）');
    return api;
}

export function persistQuickReplies() {
    try {
        const api = qrApi();
        api.settings?.save?.();
        c().saveSettingsDebounced?.();
    } catch { /* ignore */ }
}

export function qrSets() {
    const api = qrApi();
    return {
        sets: api.listSets(),
        global_mounted: api.listGlobalSets(),
        chat_mounted: api.listChatSets(),
        automation_ids: api.listAutomationIds?.() || [],
    };
}

export function qrList({ set } = {}) {
    const api = qrApi();
    if (!set) throw new Error('需要 set 名（先用 qr.sets 查）');
    const obj = api.getSetByName?.(set);
    const labels = new Set([
        ...(obj?.qrList || []).map(q => q.label),
        ...(api.listQuickReplies?.(set) || []),
    ]);
    const list = [...labels].map(label => {
        const qr = api.getQrByLabel?.(set, label) || (obj?.qrList || []).find(q => q.label === label);
        return {
            label,
            message: (qr?.message || '').slice(0, 200),
            icon: qr?.icon || '',
            hidden: !!qr?.isHidden,
            automation_id: qr?.automationId || '',
            on: {
                startup: !!qr?.executeOnStartup, user: !!qr?.executeOnUser, ai: !!qr?.executeOnAi,
                chat_change: !!qr?.executeOnChatChange, new_chat: !!qr?.executeOnNewChat,
                before_generation: !!qr?.executeBeforeGeneration,
            },
        };
    });
    const mounted = [...(api.listGlobalSets?.() || []), ...(api.listChatSets?.() || [])].includes(set);
    return { set, mounted, count: list.length, replies: list };
}

export function qrCreateSet({ name, mount = 'global' } = {}) {
    if (!name) throw new Error('需要组名');
    const api = qrApi();
    const existing = api.listSets();
    if (existing.includes(name)) throw new Error(`已存在同名组：${name}`);
    api.createSet(name);
    if (mount === 'global') api.addGlobalSet(name);
    else if (mount === 'chat') api.addChatSet(name);
    persistQuickReplies();
    return { ok: true, set: name, mounted: mount };
}

export function qrAdd({ set, label, message, icon = '', show_label = false, hidden = false, automation_id = '', on } = {}) {
    if (!set || !label) throw new Error('需要 set 与 label');
    if (!message) throw new Error('需要 message（按钮执行的 STscript 或文本）');
    const api = qrApi();
    if (!api.listSets().includes(set)) throw new Error(`没有名为「${set}」的组，先用 qr.createSet 建`);
    if (api.listQuickReplies(set).includes(label)) throw new Error(`组「${set}」里已有按钮「${label}」`);
    const o = on || {};
    const qr = api.createQuickReply(set, label, {
        message,
        icon,
        showLabel: !!show_label,
        isHidden: !!hidden,
        automationId: automation_id || '',
        executeOnStartup: !!o.startup,
        executeOnUser: !!o.user,
        executeOnAi: !!o.ai,
        executeOnChatChange: !!o.chat_change,
        executeOnNewChat: !!o.new_chat,
        executeBeforeGeneration: !!o.before_generation,
    });
    persistQuickReplies();
    return { ok: true, set, label: qr?.label ?? label, automation_id: qr?.automationId || '' };
}

export function qrDelete({ set, label } = {}) {
    if (!set || !label) throw new Error('需要 set 与 label');
    const api = qrApi();
    api.deleteQuickReply(set, label);
    persistQuickReplies();
    return { ok: true, set, label, deleted: true };
}

export async function qrRun({ set, label, args = {} } = {}) {
    if (!set || !label) throw new Error('需要 set 与 label');
    const api = qrApi();
    const result = await api.executeQuickReply(set, label, args);
    return { ok: true, set, label, result: typeof result === 'string' ? result.slice(0, 2000) : (result?.pipe ?? null) };
}

export async function searchAllChats({ query, group } = {}) {
    if (!query) throw new Error('需要 query');
    const c0 = c();
    const body = { query: String(query) };
    if (group) body.group_id = group;
    else {
        const avatar = c0.characters?.[c0.characterId]?.avatar;
        if (!avatar) throw new Error('当前没有选中角色，传 group 或先选角色再搜');
        body.avatar_url = avatar;
    }
    const res = await fetchWithTimeout('/api/chats/search', {
        method: 'POST',
        headers: { ...c0.getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`搜索失败：HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : [];
    return { query, count: list.length, hits: list.slice(0, 30) };
}

export async function genRaw({ prompt, system = '', length } = {}) {
    if (!prompt) throw new Error('需要 prompt');
    const mod = await getScriptModule();
    if (!mod?.generateRaw) throw new Error('当前版本未暴露 generateRaw');
    const text = await mod.generateRaw({
        prompt: String(prompt),
        systemPrompt: String(system || ''),
        ...(length ? { responseLength: Number(length) } : {}),
    });
    return { ok: true, chars: (text || '').length, text: String(text || '').slice(0, 4000) };
}

export const SAMPLER_KEYS = ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'openai_max_tokens', 'max_tokens'];

export function samplerStore() {
    const s = c().chatCompletionSettings || c().textCompletionSettings;
    if (!s) throw new Error('当前版本没有采样设置对象');
    return s;
}

export function samplerGet() {
    const a = c().chatCompletionSettings || {};
    const b = c().textCompletionSettings || {};
    const out = {};
    for (const k of SAMPLER_KEYS) {
        if (a[k] !== undefined && a[k] !== null) out[k] = a[k];
        else if (b[k] !== undefined && b[k] !== null) out[k] = b[k];
    }
    return { api: c().mainApi, settings: out };
}

export function samplerSet({ values, ...rest } = {}) {
    const s = samplerStore();
    const patch = values && typeof values === 'object' ? values : rest;
    const applied = {};
    for (const [k, v] of Object.entries(patch || {})) {
        if (!SAMPLER_KEYS.includes(k)) continue;
        s[k] = Number(v);
        applied[k] = s[k];
    }
    if (!Object.keys(applied).length) throw new Error(`没有可设置的字段，可用：${SAMPLER_KEYS.join(' / ')}`);
    c().saveSettingsDebounced?.();
    return { ok: true, applied };
}

/* ------------------------------ 工具清单 ------------------------------ */
