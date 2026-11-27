import { entryFields, loadBook, getEntries, setEntry, deleteEntry, bindChatBook, POSITIONS, ROLES, setInject, clearInject, listInject } from './adv-lib-world.js';
import { allRegexes, buildRegExp, testRegex, setRegexEnabled, loadPreset, listPresets, setPersona, helper, helperInfo, listScripts, setScript, scriptMod, getScriptModule } from './adv-lib-ext.js';
import { branchChatAt, renameChatTo, attachedTriggers, triggerList, detachTrigger, attachTrigger, addTrigger, removeTrigger, listTriggers, personaAvatar, listPersonas, setPersonaDesc, switchPersona, listGroups, activateGroup, countTokens, expandMacros, genInfo, stopGen, setGlobalBook, qrApi, persistQuickReplies, qrSets, qrList, qrCreateSet, qrAdd, qrDelete, qrRun, searchAllChats, genRaw, SAMPLER_KEYS, samplerStore, samplerGet, samplerSet } from './adv-lib-aux.js';

/**
 * 进阶工具层：变量（MVU）、楼层消息、世界书条目、Prompt 注入、正则试跑、预设/人格。
 * 全部走酒馆内部的 getContext() 接口，改动立刻同步到酒馆内存缓存。
 * 若检测到「酒馆助手」(JS-Slash-Runner) 的 window.TavernHelper，额外放开脚本树读写。
 */
import { getContext } from '../../../extensions.js';

export const c = () => getContext();

/* ------------------------------ 基础 ------------------------------ */

export function participants() {
    try {
        const map = c().characters ?? [];
        const ch = map[c().characterId];
        return { user: c().name1 || 'User', char: ch?.name || c().name2 || 'Character' };
    } catch {
        return { user: 'User', char: 'Character' };
    }
}

export function indexOfId(id) {
    const n = c().chat?.length ?? 0;
    if (id === 'latest' || id === undefined) return n - 1;
    const i = Number(id);
    if (!Number.isInteger(i)) throw new Error(`楼层号不合法：${id}`);
    const real = i < 0 ? n + i : i;
    if (real < 0 || real >= n) throw new Error(`楼层 ${id} 超出范围，共 ${n} 层`);
    return real;
}

export function roleOf(m) {
    if (m?.extra?.type === 'narrator') return 'system';
    return m?.is_user ? 'user' : 'assistant';
}

export function msgVars(m) {
    if (!m.variables) m.variables = [{}];
    const idx = m.swipe_id ?? 0;
    if (!m.variables[idx]) m.variables[idx] = {};
    return m.variables[idx];
}

export function parseValue(v) {
    if (v === null || v === undefined) return v;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return v; }
}

export function stringifyValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
}

export async function persistChat() {
    try { await c().saveChat?.(); } catch { /* ignore */ }
}

export function refreshMessage(id) {
    try { c().updateMessageBlock?.(id, c().chat[id]); } catch { /* ignore */ }
}

/* ------------------------------ 变量 ------------------------------ */

export function varStore(scope, messageId) {
    const scopeName = scope || 'chat';
    if (scopeName === 'chat') {
        if (!c().chatMetadata.variables) c().chatMetadata.variables = {};
        return { store: c().chatMetadata.variables, save: () => c().saveMetadataDebounced?.() };
    }
    if (scopeName === 'global') {
        const s = c().extensionSettings;
        if (!s.variables) s.variables = { global: {} };
        if (!s.variables.global) s.variables.global = {};
        return { store: s.variables.global, save: () => c().saveSettingsDebounced?.() };
    }
    if (scopeName === 'message') {
        const i = indexOfId(messageId ?? 'latest');
        const m = c().chat[i];
        if (!m) throw new Error(`楼层 ${messageId} 不存在`);
        return { store: msgVars(m), save: () => persistChat(), message: m, index: i };
    }
    if (scopeName === 'character') {
        const ch = c().characters?.[c().characterId];
        if (!ch) throw new Error('当前没有角色卡');
        ch.data = ch.data || {};
        ch.data.extensions = ch.data.extensions || {};
        if (!ch.data.extensions.variables) ch.data.extensions.variables = {};
        return { store: ch.data.extensions.variables, save: () => c().saveSettingsDebounced?.() };
    }
    throw new Error(`未知变量作用域：${scope}（可用 chat / message / global / character）`);
}

export function readVar(scope, key, messageId) {
    const { store } = varStore(scope, messageId);
    if (key === undefined || key === null || key === '') return Object.fromEntries(Object.entries(store).map(([k, v]) => [k, parseValue(v)]));
    if (!(key in store)) return null;
    return parseValue(store[key]);
}

export function writeVar(scope, key, value, messageId) {
    if (!key) throw new Error('var.set 需要 key');
    const s = varStore(scope, messageId);
    s.store[key] = stringifyValue(value);
    s.save();
    return { ok: true, scope: scope || 'chat', key, value: parseValue(s.store[key]), ...(s.index !== undefined ? { message_id: s.index } : {}) };
}

export function deleteVar(scope, key, messageId) {
    const s = varStore(scope, messageId);
    if (!(key in s.store)) return { ok: false, reason: `变量 ${key} 不存在` };
    delete s.store[key];
    s.save();
    return { ok: true, scope: scope || 'chat', deleted: key };
}

/* ------------------------------ 楼层消息 ------------------------------ */

export function describeMessage(id) {
    const m = c().chat[id];
    if (!m) return null;
    const swipeCount = Array.isArray(m.swipes) ? m.swipes.length : 0;
    return {
        id,
        role: roleOf(m),
        name: m.name,
        hidden: !!m.is_system,
        swipes: swipeCount,
        swipe_id: m.swipe_id ?? 0,
        chars: (m.mes || '').length,
        text: (m.mes || '').slice(0, 1200),
        variables: Object.keys(m.variables?.[m.swipe_id ?? 0] ?? {}),
    };
}

export function getMessages({ from, to, role, hide } = {}) {
    const total = c().chat?.length ?? 0;
    if (!total) return { total: 0, messages: [] };
    const start = from === undefined || from === '' ? 0 : Math.max(0, indexOfId(from));
    const end = to === undefined || to === '' ? total - 1 : Math.min(total - 1, indexOfId(to));
    const out = [];
    for (let i = start; i <= end; i++) {
        const d = describeMessage(i);
        if (!d) continue;
        if (role && role !== 'all' && d.role !== role) continue;
        if (hide === 'hidden' && !d.hidden) continue;
        if (hide === 'visible' && d.hidden) continue;
        out.push(d);
    }
    return { total, range: [start, end], count: out.length, messages: out };
}

export function setMessage({ id, text, name, role, hidden }) {
    const i = indexOfId(id);
    const m = c().chat[i];
    if (!m) throw new Error(`楼层 ${id} 不存在`);
    if (typeof text === 'string') {
        m.mes = text;
        if (Array.isArray(m.swipes)) m.swipes[m.swipe_id ?? 0] = text;
    }
    if (name) m.name = name;
    if (role) {
        if (role === 'system') { m.extra = m.extra || {}; m.extra.type = 'narrator'; }
        else {
            m.is_user = role === 'user';
            if (m.extra?.type === 'narrator') delete m.extra.type;
        }
    }
    if (typeof hidden === 'boolean') m.is_system = hidden;
    persistChat();
    refreshMessage(i);
    return describeMessage(i);
}

export function createMessage({ role = 'user', text = '', name, hidden = false, at } = {}) {
    const p = participants();
    const message = {
        name: name || (role === 'user' ? p.user : role === 'system' ? 'system' : p.char),
        is_user: role === 'user',
        is_system: !!hidden,
        mes: String(text ?? ''),
        ...(role === 'system' ? { extra: { type: 'narrator' } } : {}),
    };
    const total = c().chat?.length ?? 0;
    let insertBefore = total;
    if (at !== undefined && at !== null && at !== '') {
        insertBefore = at === 'end' ? total : Math.max(0, Math.min(total, Number(at)));
    }
    c().chat.splice(insertBefore, 0, message);
    if (insertBefore === total && typeof c().addOneMessage === 'function') {
        try { c().addOneMessage(message, { scroll: true }); } catch { /* ignore */ }
    } else {
        persistChat();
        try { c().printMessages?.(); } catch { /* ignore */ }
    }
    return { ok: true, inserted_at: insertBefore, total: c().chat.length, message: describeMessage(insertBefore) };
}

export function deleteMessages({ id, ids, count = 1 }) {
    let targets = [];
    if (Array.isArray(ids) && ids.length) targets = ids.map(x => indexOfId(x));
    else targets = Array.from({ length: Math.max(1, Number(count) || 1) }, (_, k) => indexOfId(id) + k)
        .filter(i => i < (c().chat?.length ?? 0));
    targets = [...new Set(targets)].sort((a, b) => b - a);
    const removed = targets.map(i => ({ id: i, text: (c().chat[i]?.mes || '').slice(0, 100) }));
    for (const i of targets) c().chat.splice(i, 1);
    persistChat();
    try { c().printMessages?.(); } catch { /* ignore */ }
    return { ok: true, removed, total: c().chat.length };
}

export async function swipeMessage({ id, dir = 'right', index } = {}) {
    const i = indexOfId(id);
    const sw = c().swipe;
    if (!sw) throw new Error('当前酒馆版本不支持 swipe 接口');
    if (index !== undefined) await sw.to(index);
    else if (dir === 'left') await sw.left();
    else await sw.right();
    return describeMessage(i);
}

/* ------------------------------ 世界书条目 ------------------------------ */
