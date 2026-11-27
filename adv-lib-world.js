import { getContext } from '../../../extensions.js';
import { c, participants, indexOfId, roleOf, msgVars, parseValue, stringifyValue, persistChat, refreshMessage, varStore, readVar, writeVar, deleteVar, describeMessage, getMessages, setMessage, createMessage, deleteMessages, swipeMessage } from './adv-lib-core.js';
import { allRegexes, buildRegExp, testRegex, setRegexEnabled, loadPreset, listPresets, setPersona, helper, helperInfo, listScripts, setScript, scriptMod, getScriptModule } from './adv-lib-ext.js';
import { branchChatAt, renameChatTo, attachedTriggers, triggerList, detachTrigger, attachTrigger, addTrigger, removeTrigger, listTriggers, personaAvatar, listPersonas, setPersonaDesc, switchPersona, listGroups, activateGroup, countTokens, expandMacros, genInfo, stopGen, setGlobalBook, qrApi, persistQuickReplies, qrSets, qrList, qrCreateSet, qrAdd, qrDelete, qrRun, searchAllChats, genRaw, SAMPLER_KEYS, samplerStore, samplerGet, samplerSet } from './adv-lib-aux.js';

export function entryFields(e) {
    return {
        uid: e.uid,
        keys: e.key,
        secondary_keys: e.keysecondary,
        content: e.content,
        comment: e.comment,
        order: e.order,
        position: e.position,
        depth: e.depth,
        probability: e.probability,
        useProbability: e.useProbability,
        constant: e.constant,
        enabled: !e.disable,
        role: e.role,
    };
}

export async function loadBook(name) {
    if (!name) throw new Error('需要世界书名字（先用 world.list 查）');
    const data = await c().loadWorldInfo(name);
    if (!data) throw new Error(`世界书「${name}」不存在或为空`);
    data.entries = data.entries || {};
    return data;
}

export async function getEntries({ name, uid, keyword, limit = 50 } = {}) {
    const data = await loadBook(name);
    let list = Object.values(data.entries).map(entryFields);
    if (uid !== undefined && uid !== null && uid !== '') {
        const found = list.find(e => String(e.uid) === String(uid));
        return found ? { count: 1, entries: [found] } : { count: 0, entries: [] };
    }
    if (keyword) {
        const k = String(keyword).toLowerCase();
        list = list.filter(e => [e.comment, e.content, ...(e.keys || [])].join(' ').toLowerCase().includes(k));
    }
    return { names: data.name === undefined ? name : name, count: list.length, entries: list.slice(0, Number(limit) || 50) };
}

export async function setEntry({ name, uid, keys, content, comment, order, position, depth, probability, constant, enabled, secondary_keys, role }) {
    const data = await loadBook(name);
    let target;
    if (uid !== undefined && uid !== null && uid !== '' && data.entries[uid]) {
        target = data.entries[uid];
    } else if (uid !== undefined && uid !== null && uid !== '' && String(uid).trim() !== '') {
        // 允许显式指定不存在的 uid 来新建
        target = { uid: Number(uid) };
        data.entries[Number(uid)] = target;
    } else {
        const max = Object.values(data.entries).reduce((n, e) => Math.max(n, Number(e.uid) || 0), 0);
        target = { uid: max + 1 };
        data.entries[target.uid] = target;
    }
    if (Array.isArray(keys)) target.key = keys;
    else if (typeof keys === 'string' && keys) target.key = keys.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    if (secondary_keys !== undefined) target.keysecondary = Array.isArray(secondary_keys) ? secondary_keys : String(secondary_keys || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
    if (content !== undefined) target.content = content;
    if (comment !== undefined) target.comment = comment;
    if (order !== undefined) target.order = Number(order);
    if (position !== undefined) target.position = Number(position);
    if (depth !== undefined) target.depth = Number(depth);
    if (probability !== undefined) target.probability = Number(probability);
    if (constant !== undefined) target.constant = !!constant;
    if (enabled !== undefined) target.disable = !enabled;
    if (role !== undefined) target.role = Number(role);
    // 补齐酒馆要求的默认字段，避免新条目在 UI 里显示异常
    if (target.key === undefined) target.key = [];
    if (target.keysecondary === undefined) target.keysecondary = [];
    if (target.content === undefined) target.content = '';
    if (target.comment === undefined) target.comment = '';
    if (target.order === undefined) target.order = 100;
    if (target.position === undefined) target.position = 0;
    if (target.disable === undefined) target.disable = false;
    if (target.constant === undefined) target.constant = false;
    if (target.selective === undefined) target.selective = null;
    if (target.additive === undefined) target.additive = 100;
    if (target.selectiveLogic === undefined) target.selectiveLogic = 0;
    if (target.useProbability === undefined) target.useProbability = true;
    if (target.probability === undefined) target.probability = 100;
    if (target.depth === undefined) target.depth = target.constant ? 4 : 4;
    if (target.group === undefined) target.group = '';
    if (target.groupOverride === undefined) target.groupOverride = false;
    if (target.groupWeight === undefined) target.groupWeight = 100;
    if (target.scanDepth === undefined) target.scanDepth = null;
    if (target.caseSensitive === undefined) target.caseSensitive = null;
    if (target.matchWholeWords === undefined) target.matchWholeWords = null;
    if (target.role === undefined) target.role = null;
    if (target.vectorized === undefined) target.vectorized = false;
    if (target.vectorIndex === undefined) target.vectorIndex = null;
    if (target.index === undefined) target.index = null;
    await c().saveWorldInfo(name, data, true);
    try { c().reloadWorldInfoEditor?.(name, true); } catch { /* ignore */ }
    return entryFields(target);
}

export async function deleteEntry({ name, uid }) {
    if (uid === undefined || uid === null || uid === '') throw new Error('lb.deleteEntry 需要 uid');
    const data = await loadBook(name);
    if (!data.entries[uid]) return { ok: false, reason: `条目 ${uid} 不存在` };
    const removed = entryFields(data.entries[uid]);
    delete data.entries[uid];
    await c().saveWorldInfo(name, data, true);
    try { c().reloadWorldInfoEditor?.(name, true); } catch { /* ignore */ }
    return { ok: true, removed: { uid: removed.uid, comment: removed.comment } };
}

export function bindChatBook({ name } = {}) {
    if (!name) throw new Error('需要世界书名字');
    if (!c().getWorldInfoNames?.().includes(name)) throw new Error(`世界书「${name}」不存在`);
    c().chatMetadata.world_info = name;
    c().saveMetadataDebounced?.();
    return { ok: true, chat_book: name, chat: c().chatId || '(未命名聊天)' };
}

/* ------------------------------ Prompt 注入 ------------------------------ */

export const POSITIONS = { in_prompt: 0, in_chat: 1, before_prompt: 2 };
export const ROLES = { system: 0, user: 1, assistant: 2 };

export function setInject({ key = 'st-agent', text = '', position = 'in_chat', depth = 4, role = 'system', scan = false }) {
    const pos = POSITIONS[position];
    if (pos === undefined) throw new Error(`position 只能是 in_prompt / in_chat / before_prompt`);
    const r = ROLES[role];
    if (r === undefined) throw new Error(`role 只能是 system / user / assistant`);
    c().setExtensionPrompt(key, String(text), pos, Number(depth) || 0, !!scan, r);
    return { ok: true, key, position, depth: Number(depth) || 0, role, chars: String(text).length };
}

export function clearInject({ key = 'st-agent' } = {}) {
    const prompts = c().extensionPrompts;
    if (!prompts) return { ok: false, reason: '当前版本没有 extensionPrompts' };
    if (!(key in prompts)) return { ok: false, reason: `没有 key=${key} 的注入` };
    delete prompts[key];
    return { ok: true, cleared: key };
}

export function listInject() {
    const prompts = c().extensionPrompts || {};
    return {
        count: Object.keys(prompts).length,
        prompts: Object.entries(prompts).map(([k, v]) => ({
            key: k,
            position: v.position,
            depth: v.depth,
            role: v.role,
            scan: v.scan,
            chars: (v.value || '').length,
            preview: (v.value || '').slice(0, 80),
        })),
    };
}

/* ------------------------------ 正则 ------------------------------ */
