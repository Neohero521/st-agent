/**
 * 进阶工具层：变量（MVU）、楼层消息、世界书条目、Prompt 注入、正则试跑、预设/人格。
 * 全部走酒馆内部的 getContext() 接口，改动立刻同步到酒馆内存缓存。
 * 若检测到「酒馆助手」(JS-Slash-Runner) 的 window.TavernHelper，额外放开脚本树读写。
 */
import { getContext } from '../../../extensions.js';

const c = () => getContext();

/* ------------------------------ 基础 ------------------------------ */

function participants() {
    try {
        const map = c().characters ?? [];
        const ch = map[c().characterId];
        return { user: c().name1 || 'User', char: ch?.name || c().name2 || 'Character' };
    } catch {
        return { user: 'User', char: 'Character' };
    }
}

function indexOfId(id) {
    const n = c().chat?.length ?? 0;
    if (id === 'latest' || id === undefined) return n - 1;
    const i = Number(id);
    if (!Number.isInteger(i)) throw new Error(`楼层号不合法：${id}`);
    const real = i < 0 ? n + i : i;
    if (real < 0 || real >= n) throw new Error(`楼层 ${id} 超出范围，共 ${n} 层`);
    return real;
}

function roleOf(m) {
    if (m?.extra?.type === 'narrator') return 'system';
    return m?.is_user ? 'user' : 'assistant';
}

function msgVars(m) {
    if (!m.variables) m.variables = [{}];
    const idx = m.swipe_id ?? 0;
    if (!m.variables[idx]) m.variables[idx] = {};
    return m.variables[idx];
}

function parseValue(v) {
    if (v === null || v === undefined) return v;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return v; }
}

function stringifyValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
}

async function persistChat() {
    try { await c().saveChat?.(); } catch { /* ignore */ }
}

function refreshMessage(id) {
    try { c().updateMessageBlock?.(id, c().chat[id]); } catch { /* ignore */ }
}

/* ------------------------------ 变量 ------------------------------ */

function varStore(scope, messageId) {
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

function readVar(scope, key, messageId) {
    const { store } = varStore(scope, messageId);
    if (key === undefined || key === null || key === '') return Object.fromEntries(Object.entries(store).map(([k, v]) => [k, parseValue(v)]));
    if (!(key in store)) return null;
    return parseValue(store[key]);
}

function writeVar(scope, key, value, messageId) {
    if (!key) throw new Error('var.set 需要 key');
    const s = varStore(scope, messageId);
    s.store[key] = stringifyValue(value);
    s.save();
    return { ok: true, scope: scope || 'chat', key, value: parseValue(s.store[key]), ...(s.index !== undefined ? { message_id: s.index } : {}) };
}

function deleteVar(scope, key, messageId) {
    const s = varStore(scope, messageId);
    if (!(key in s.store)) return { ok: false, reason: `变量 ${key} 不存在` };
    delete s.store[key];
    s.save();
    return { ok: true, scope: scope || 'chat', deleted: key };
}

/* ------------------------------ 楼层消息 ------------------------------ */

function describeMessage(id) {
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

function getMessages({ from, to, role, hide } = {}) {
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

function setMessage({ id, text, name, role, hidden }) {
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

function createMessage({ role = 'user', text = '', name, hidden = false, at } = {}) {
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

function deleteMessages({ id, ids, count = 1 }) {
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

async function swipeMessage({ id, dir = 'right', index } = {}) {
    const i = indexOfId(id);
    const sw = c().swipe;
    if (!sw) throw new Error('当前酒馆版本不支持 swipe 接口');
    if (index !== undefined) await sw.to(index);
    else if (dir === 'left') await sw.left();
    else await sw.right();
    return describeMessage(i);
}

/* ------------------------------ 世界书条目 ------------------------------ */

function entryFields(e) {
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

async function loadBook(name) {
    if (!name) throw new Error('需要世界书名字（先用 world.list 查）');
    const data = await c().loadWorldInfo(name);
    if (!data) throw new Error(`世界书「${name}」不存在或为空`);
    data.entries = data.entries || {};
    return data;
}

async function getEntries({ name, uid, keyword, limit = 50 } = {}) {
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

async function setEntry({ name, uid, keys, content, comment, order, position, depth, probability, constant, enabled, secondary_keys, role }) {
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

async function deleteEntry({ name, uid }) {
    if (uid === undefined || uid === null || uid === '') throw new Error('lb.deleteEntry 需要 uid');
    const data = await loadBook(name);
    if (!data.entries[uid]) return { ok: false, reason: `条目 ${uid} 不存在` };
    const removed = entryFields(data.entries[uid]);
    delete data.entries[uid];
    await c().saveWorldInfo(name, data, true);
    try { c().reloadWorldInfoEditor?.(name, true); } catch { /* ignore */ }
    return { ok: true, removed: { uid: removed.uid, comment: removed.comment } };
}

function bindChatBook({ name } = {}) {
    if (!name) throw new Error('需要世界书名字');
    if (!c().getWorldInfoNames?.().includes(name)) throw new Error(`世界书「${name}」不存在`);
    c().chatMetadata.world_info = name;
    c().saveMetadataDebounced?.();
    return { ok: true, chat_book: name, chat: c().chatId || '(未命名聊天)' };
}

/* ------------------------------ Prompt 注入 ------------------------------ */

const POSITIONS = { in_prompt: 0, in_chat: 1, before_prompt: 2 };
const ROLES = { system: 0, user: 1, assistant: 2 };

function setInject({ key = 'st-agent', text = '', position = 'in_chat', depth = 4, role = 'system', scan = false }) {
    const pos = POSITIONS[position];
    if (pos === undefined) throw new Error(`position 只能是 in_prompt / in_chat / before_prompt`);
    const r = ROLES[role];
    if (r === undefined) throw new Error(`role 只能是 system / user / assistant`);
    c().setExtensionPrompt(key, String(text), pos, Number(depth) || 0, !!scan, r);
    return { ok: true, key, position, depth: Number(depth) || 0, role, chars: String(text).length };
}

function clearInject({ key = 'st-agent' } = {}) {
    const prompts = c().extensionPrompts;
    if (!prompts) return { ok: false, reason: '当前版本没有 extensionPrompts' };
    if (!(key in prompts)) return { ok: false, reason: `没有 key=${key} 的注入` };
    delete prompts[key];
    return { ok: true, cleared: key };
}

function listInject() {
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

function allRegexes() {
    const out = [];
    const list = c().extensionSettings?.regex || [];
    for (const r of list) out.push({ source: 'global', ...r });
    const ch = c().characters?.[c().characterId];
    const cr = ch?.data?.extensions?.regex_scripts || [];
    for (const r of cr) out.push({ source: 'character', ...r });
    return out;
}

function buildRegExp(pattern) {
    const s = String(pattern ?? '');
    const m = /^\/([\s\S]*)\/([gimsuy]*)$/.exec(s.trim());
    if (m) {
        try { return new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g'); } catch { return null; }
    }
    try { return new RegExp(s, 'g'); } catch { return null; }
}

function testRegex({ id, text = '' } = {}) {
    const target = allRegexes().find(r => String(r.id) === String(id) || r.scriptName === id);
    if (!target) throw new Error(`没有 id=${id} 的正则`);
    const re = buildRegExp(target.find_regex);
    if (!re) throw new Error('正则表达式无效：' + target.find_regex);
    const before = String(text);
    const out = before.replace(re, String(target.replace_string ?? ''));
    return {
        id: target.id,
        name: target.scriptName || target.id,
        source: target.source,
        disabled: !!target.disabled,
        placement: target.placement,
        changed: out !== before,
        chars_before: before.length,
        chars_after: out.length,
        output: out.slice(0, 2000),
    };
}

function setRegexEnabled({ id, enabled = true } = {}) {
    const target = allRegexes().find(r => String(r.id) === String(id) || r.scriptName === id);
    if (!target) throw new Error(`没有 id=${id} 的正则`);
    if (target.source === 'global') {
        const list = c().extensionSettings.regex;
        const item = list.find(r => r.id === target.id || r.scriptName === id);
        if (!item) throw new Error('未找到全局正则对象');
        item.disabled = !enabled;
        c().saveSettingsDebounced?.();
    } else {
        const ch = c().characters?.[c().characterId];
        const item = (ch?.data?.extensions?.regex_scripts || []).find(r => r.id === target.id || r.scriptName === id);
        if (!item) throw new Error('未找到角色正则对象');
        item.disabled = !enabled;
        c().writeExtensionField?.(c().characterId, 'regex_scripts', ch.data.extensions.regex_scripts);
    }
    return { ok: true, id: target.id, name: target.scriptName || target.id, enabled: !!enabled };
}

/* ------------------------------ 预设 / 人格 ------------------------------ */

async function loadPreset({ name, api = 'openai' } = {}) {
    if (!name) throw new Error('需要预设名字');
    const pm = c().getPresetManager?.(api);
    if (!pm) throw new Error(`没有 api=${api} 的预设管理器（可用 openai / textgeneration / instruct …）`);
    await pm.selectPreset(name);
    return { ok: true, api, preset: name };
}

function listPresets({ api = 'openai' } = {}) {
    const pm = c().getPresetManager?.(api);
    if (!pm) throw new Error(`没有 api=${api} 的预设管理器`);
    const data = pm.getPresetList?.() || {};
    return { api, count: (data.preset_names || []).length, presets: data.preset_names || [] };
}

function setPersona({ text } = {}) {
    const pu = c().powerUserSettings;
    if (!pu) throw new Error('当前版本没有 powerUserSettings');
    pu.persona_description = String(text ?? '');
    c().saveSettingsDebounced?.();
    return { ok: true, chars: pu.persona_description.length };
}

/* ------------------------------ 酒馆助手（可选） ------------------------------ */

function helper() {
    return globalThis.TavernHelper || window.TavernHelper || null;
}

function helperInfo() {
    const th = helper();
    if (!th) return { online: false };
    let version = '?';
    try { version = th.getTavernHelperVersion?.() ?? '?'; } catch { /* ignore */ }
    return { online: true, version };
}

function listScripts() {
    const th = helper();
    if (!th?.getScriptTrees) throw new Error('需要安装「酒馆助手」(JS-Slash-Runner) 4.x');
    const trees = th.getScriptTrees();
    return { count: (trees || []).length, scripts: (trees || []).map(t => ({ name: t.name, type: t.type, enabled: t.enabled, id: t.id })) };
}

function setScript({ name, code, enabled = true } = {}) {
    const th = helper();
    if (!th?.getScriptTrees || !th?.replaceScriptTrees) throw new Error('需要安装「酒馆助手」(JS-Slash-Runner) 4.x');
    if (!name) throw new Error('需要脚本名');
    const trees = th.getScriptTrees() || [];
    const stripId = t => ({ name: t.name, type: t.type, enabled: t.enabled, code: t.code, info: t.info, buttons: t.buttons });
    const exists = trees.find(t => t.name === name);
    let next;
    if (exists) {
        next = trees.map(t => (t.name === name ? { ...stripId(t), enabled: !!enabled, ...(code !== undefined ? { code } : {}) } : stripId(t)));
    } else {
        next = [...trees.map(stripId), { name, type: 'script', enabled: !!enabled, code: String(code || ''), info: '', buttons: [] }];
    }
    th.replaceScriptTrees(next);
    return { ok: true, name, action: exists ? 'updated' : 'created', total: next.length };
}

/* ------------------------------ v1.2：分支 / 事件触发器 / 人格 / 群聊 / 宏 ------------------------------ */

let scriptMod;

async function getScriptModule() {
    if (scriptMod !== undefined) return scriptMod;
    for (const path of ['/script.js', '../../../../script.js', '../../../script.js']) {
        try {
            const mod = await import(path);
            if (mod) { scriptMod = mod; return scriptMod; }
        } catch { /* try next */ }
    }
    scriptMod = null;
    return scriptMod;
}

async function branchChatAt({ id = -1 } = {}) {
    const index = indexOfId(id);
    let mod;
    for (const path of ['/scripts/bookmarks.js', '../../../../scripts/bookmarks.js']) {
        try { mod = await import(path); break; } catch { /* try next */ }
    }
    if (!mod?.branchChat) throw new Error('当前酒馆版本未暴露 branchChat（需要 1.12+）');
    const name = await mod.branchChat(index, {});
    return { ok: !!name, from_message: index, new_chat: name || null };
}

function renameChatTo({ name } = {}) {
    if (!name) throw new Error('需要新聊天名');
    if (!c().chatId) throw new Error('当前没有打开的聊天');
    c().renameChat?.(name);
    return { ok: true, old: c().chatId, note: 'renameChat 由酒馆内部完成，新名以 UI 为准' };
}

/* --- 事件触发器：让 Agent 能"盯着"酒馆，被动变主动 --- */

const attachedTriggers = new Map();

function triggerList() {
    try {
        const es = c().extensionSettings;
        if (!Array.isArray(es['st-agent-triggers'])) es['st-agent-triggers'] = [];
        return es['st-agent-triggers'];
    } catch {
        return [];
    }
}

function detachTrigger(id) {
    const item = attachedTriggers.get(id);
    if (!item) return false;
    try { c().eventSource?.removeListener?.(item.event, item.handler); } catch { /* ignore */ }
    attachedTriggers.delete(id);
    return true;
}

function attachTrigger(t) {
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

function addTrigger({ id, event = 'message_received', match = '', task = '' } = {}) {
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

function removeTrigger({ id } = {}) {
    if (!id) throw new Error('需要触发器 id');
    const list = triggerList();
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return { ok: false, reason: `没有 id=${id} 的触发器` };
    list.splice(i, 1);
    c().saveSettingsDebounced?.();
    const detached = detachTrigger(id);
    return { ok: true, removed: id, detached };
}

function listTriggers() {
    const list = triggerList();
    const types = Object.keys(c().eventTypes || {}).sort();
    return {
        count: list.length,
        triggers: list.map(t => ({ ...t, attached: attachedTriggers.has(t.id) })),
        usable_events: types.slice(0, 40),
    };
}

/* --- 人格 --- */

function personaAvatar(name) {
    // power_user.personas: { avatar文件名: 显示名 }
    const pu = c().powerUserSettings || {};
    const pair = Object.entries(pu.personas || {}).find(([, n]) => n === name);
    return pair ? pair[0] : null;
}

function listPersonas() {
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

function setPersonaDesc({ text, name, position, depth, role } = {}) {
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

async function switchPersona({ name } = {}) {
    if (!name) throw new Error('需要人格名');
    if (!personaAvatar(name)) throw new Error(`没有名为「${name}」的人格`);
    const mod = await getScriptModule();
    if (!mod?.setUserName) throw new Error('当前版本未暴露 setUserName');
    await mod.setUserName(name);
    return { ok: true, user: c().name1 };
}

/* --- 群聊 --- */

function listGroups() {
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

async function activateGroup({ id, name } = {}) {
    const groups = c().groups || [];
    const g = groups.find(x => String(x.id) === String(id)) || groups.find(x => x.name === name);
    if (!g) throw new Error('找不到该群聊，先用 group.list 查 id');
    if (!g.chat_id) throw new Error(`群聊「${g.name}」还没有聊天文件，请先在 UI 里打开一次`);
    await c().openGroupChat(g.id, g.chat_id);
    return { ok: true, group: g.name, chat: g.chat_id };
}

/* --- 杂项 --- */

async function countTokens({ text } = {}) {
    if (text === undefined) throw new Error('需要 text');
    const n = await c().getTokenCountAsync?.(String(text));
    if (n === undefined || n === null) throw new Error('当前版本没有 getTokenCountAsync');
    return { tokens: n, chars: String(text).length };
}

function expandMacros({ text } = {}) {
    if (text === undefined) throw new Error('需要 text');
    const out = c().substituteParams?.(String(text));
    if (out === undefined) throw new Error('当前版本没有 substituteParams');
    return { input: String(text), output: String(out) };
}

function genInfo() {
    return {
        main_api: c().mainApi,
        model: (() => { try { return c().getChatCompletionModel?.() || null; } catch { return null; } })(),
        max_context: c().maxContext,
        chat: c().chatId || null,
        messages: c().chat?.length ?? 0,
    };
}

async function stopGen() {
    try {
        await c().stopGeneration?.();
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: error.message };
    }
}

async function setGlobalBook({ name } = {}) {
    if (!name) throw new Error('需要世界书名字');
    if (!c().getWorldInfoNames?.().includes(name)) throw new Error(`世界书「${name}」不存在`);
    const r = await c().executeSlashCommandsWithOptions?.(`/world ${name}`);
    return { ok: true, global_book: name, result: r?.pipe ?? null };
}

/* ------------------------------ v1.3：快速回复 / 全库检索 / 独立生成 / 采样器 ------------------------------ */

function qrApi() {
    const api = globalThis.quickReplyApi;
    if (!api) throw new Error('没找到 quickReplyApi（酒馆「快速回复」扩展未启用）');
    return api;
}

function persistQuickReplies() {
    try {
        const api = qrApi();
        api.settings?.save?.();
        c().saveSettingsDebounced?.();
    } catch { /* ignore */ }
}

function qrSets() {
    const api = qrApi();
    return {
        sets: api.listSets(),
        global_mounted: api.listGlobalSets(),
        chat_mounted: api.listChatSets(),
        automation_ids: api.listAutomationIds?.() || [],
    };
}

function qrList({ set } = {}) {
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

function qrCreateSet({ name, mount = 'global' } = {}) {
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

function qrAdd({ set, label, message, icon = '', show_label = false, hidden = false, automation_id = '', on } = {}) {
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

function qrDelete({ set, label } = {}) {
    if (!set || !label) throw new Error('需要 set 与 label');
    const api = qrApi();
    api.deleteQuickReply(set, label);
    persistQuickReplies();
    return { ok: true, set, label, deleted: true };
}

async function qrRun({ set, label, args = {} } = {}) {
    if (!set || !label) throw new Error('需要 set 与 label');
    const api = qrApi();
    const result = await api.executeQuickReply(set, label, args);
    return { ok: true, set, label, result: typeof result === 'string' ? result.slice(0, 2000) : (result?.pipe ?? null) };
}

async function searchAllChats({ query, group } = {}) {
    if (!query) throw new Error('需要 query');
    const c0 = c();
    const body = { query: String(query) };
    if (group) body.group_id = group;
    else {
        const avatar = c0.characters?.[c0.characterId]?.avatar;
        if (!avatar) throw new Error('当前没有选中角色，传 group 或先选角色再搜');
        body.avatar_url = avatar;
    }
    const res = await fetch('/api/chats/search', {
        method: 'POST',
        headers: { ...c0.getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`搜索失败：HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : [];
    return { query, count: list.length, hits: list.slice(0, 30) };
}

async function genRaw({ prompt, system = '', length } = {}) {
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

const SAMPLER_KEYS = ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'openai_max_tokens', 'max_tokens'];

function samplerStore() {
    const s = c().chatCompletionSettings || c().textCompletionSettings;
    if (!s) throw new Error('当前版本没有采样设置对象');
    return s;
}

function samplerGet() {
    const a = c().chatCompletionSettings || {};
    const b = c().textCompletionSettings || {};
    const out = {};
    for (const k of SAMPLER_KEYS) {
        if (a[k] !== undefined && a[k] !== null) out[k] = a[k];
        else if (b[k] !== undefined && b[k] !== null) out[k] = b[k];
    }
    return { api: c().mainApi, settings: out };
}

function samplerSet({ values, ...rest } = {}) {
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

export const ADV_TOOLS = [
    {
        name: 'var.get', kind: 'read',
        desc: '读变量。scope=chat（聊天变量，MVU 主用）/ message（楼层变量）/ global（全局）/ character（角色卡）。message 作用域用 message_id 指定楼层（可 -1 表示最新）。',
        params: { scope: 'chat|message|global|character，默认 chat', key: '变量名，省略则返回全部', message_id: '楼层号，仅 message 作用域需要' },
        run: a => readVar(a.scope, a.key, a.message_id),
    },
    {
        name: 'var.set', kind: 'write',
        desc: '写变量（值会自动 JSON 字符串化，与酒馆 /setvar 行为一致）。对象/数组直接传 JSON。',
        params: { scope: '同上', key: '变量名（必填）', value: '新值', message_id: '楼层号' },
        run: a => writeVar(a.scope, a.key, a.value, a.message_id),
    },
    {
        name: 'var.delete', kind: 'write',
        desc: '删变量。',
        params: { scope: '同上', key: '变量名', message_id: '楼层号' },
        run: a => deleteVar(a.scope, a.key, a.message_id),
    },
    {
        name: 'msg.get', kind: 'read',
        desc: '读楼层消息（id/role/name/是否隐藏/swipe 数/变量名/正文前 1200 字）。不传范围则返回全部。',
        params: { from: '起始楼层（可负数）', to: '结束楼层', role: 'all|user|assistant|system', hide: 'all|hidden|visible' },
        run: a => getMessages(a),
    },
    {
        name: 'msg.set', kind: 'write',
        desc: '改某个楼层：正文（同步当前 swipe）、说话人、role（user/assistant/system）、是否隐藏。',
        params: { id: '楼层号（-1 = 最新）', text: '新正文', name: '说话人显示名', role: 'user|assistant|system', hidden: 'true 隐藏 / false 显示' },
        run: a => setMessage(a),
    },
    {
        name: 'msg.create', kind: 'write',
        desc: '插入一条楼层。role=system 会写成旁白（narrator）。',
        params: { role: 'user|assistant|system', text: '正文', name: '显示名', hidden: '是否隐藏', at: '插入位置（楼层号，默认末尾）' },
        run: a => createMessage(a),
    },
    {
        name: 'msg.delete', kind: 'dangerous',
        desc: '删除楼层。给 ids 数组按多楼，或用 id + count 连续删。',
        params: { id: '起始楼层', ids: '楼层数组', count: '连续删除数量，默认 1' },
        run: a => deleteMessages(a),
    },
    {
        name: 'msg.swipe', kind: 'write',
        desc: '切换某楼的 swipe（多回复版本）。dir=left/right，或用 index 直接跳。',
        params: { id: '楼层号', dir: 'left|right', index: '目标 swipe 序号' },
        run: a => swipeMessage(a),
    },
    {
        name: 'lb.getEntries', kind: 'read',
        desc: '读世界书条目（含 keys/content/order/position/depth/probability/constant/enabled）。可用 keyword 模糊搜。',
        params: { name: '世界书名', uid: '只看某条', keyword: '关键词', limit: '返回条数上限，默认 50' },
        run: a => getEntries(a),
    },
    {
        name: 'lb.setEntry', kind: 'write',
        desc: '写世界书条目：有 uid 就改，没有就新建（自动分配 uid）。只传要改的字段。',
        params: { name: '世界书名', uid: '条目 uid', keys: '主关键词（数组或逗号分隔）', secondary_keys: '次关键词', content: '内容', comment: '备注/标题', order: '插入顺序', position: '0 前置/1 后置/…', depth: '深度', probability: '触发概率', constant: '常驻', enabled: '启用' },
        run: a => setEntry(a),
    },
    {
        name: 'lb.deleteEntry', kind: 'dangerous',
        desc: '删除世界书某条目。',
        params: { name: '世界书名', uid: '条目 uid' },
        run: a => deleteEntry(a),
    },
    {
        name: 'lb.bindChat', kind: 'write',
        desc: '把世界书设为当前聊天的挂载世界书（chat lorebook）。',
        params: { name: '世界书名' },
        run: a => bindChatBook(a),
    },
    {
        name: 'inject.set', kind: 'write',
        desc: '往提示词里注入一段常驻文本（扩展注入位）。position=in_chat 时按 depth 插进对话。',
        params: { key: '注入槽位名，默认 st-agent', text: '文本', position: 'in_prompt|in_chat|before_prompt', depth: 'in_chat 时的深度', role: 'system|user|assistant', scan: '是否允许世界书扫描' },
        run: a => setInject(a),
    },
    {
        name: 'inject.clear', kind: 'write',
        desc: '清掉某个注入槽位。',
        params: { key: '槽位名' },
        run: a => clearInject(a),
    },
    {
        name: 'inject.list', kind: 'read',
        desc: '列出当前所有提示词注入（含酒馆自带的 note/depth prompt）。',
        params: {},
        run: () => listInject(),
    },
    {
        name: 'regex.test', kind: 'read',
        desc: '拿真实正则对一段文本试跑，看替换结果（不动聊天）。',
        params: { id: '正则 id 或 scriptName', text: '待测文本' },
        run: a => testRegex(a),
    },
    {
        name: 'regex.setEnabled', kind: 'write',
        desc: '启用/停用某条正则（全局或角色正则都支持）。',
        params: { id: '正则 id 或 scriptName', enabled: 'true 启用 / false 停用' },
        run: a => setRegexEnabled(a),
    },
    {
        name: 'preset.list', kind: 'read',
        desc: '列预设名。api 默认 openai，文本补全用 textgeneration，指令模式用 instruct。',
        params: { api: 'openai|textgeneration|instruct|novel|kobold' },
        run: a => listPresets(a),
    },
    {
        name: 'preset.load', kind: 'write',
        desc: '加载某个预设（等同在 UI 里点选）。',
        params: { name: '预设名', api: '同上' },
        run: a => loadPreset(a),
    },
    {
        name: 'persona.set', kind: 'write',
        desc: '改用户人格描述（{user} 宏的内容）。',
        params: { text: '人格描述' },
        run: a => setPersona(a),
    },
    {
        name: 'script.list', kind: 'read',
        desc: '列出「酒馆助手」里的脚本/前端卡（需安装 JS-Slash-Runner 4.x）。',
        params: {},
        run: () => listScripts(),
    },
    {
        name: 'script.set', kind: 'write',
        desc: '在「酒馆助手」里新建/更新一个脚本（code 为完整 JS 源码，可实现任意酒馆改造）。',
        params: { name: '脚本名', code: 'JS 源码', enabled: '是否启用' },
        run: a => setScript(a),
    },
    /* ---------- v1.2 ---------- */
    {
        name: 'chat.branch', kind: 'write',
        desc: '从某楼开始分叉出一条新聊天（SSD 式叙事分支）。会切换当前聊天。',
        params: { id: '分叉起点楼层 id，-1=最后一楼' },
        run: a => branchChatAt(a),
    },
    {
        name: 'chat.rename', kind: 'write',
        desc: '重命名当前聊天文件。',
        params: { name: '新名字' },
        run: a => renameChatTo(a),
    },
    {
        name: 'event.on', kind: 'write',
        desc: '注册一个触发器：酒馆里发生某事件且内容命中关键词时，自动跑一个 Agent 任务（被动变主动）。task 里可用 {text} 占位命中内容。',
        params: { id: '可选 id', event: 'message_received / message_sent / character_message_rendered / generation_after_commands', match: '关键词或 /正则/', task: '要执行的任务' },
        run: a => addTrigger(a),
    },
    {
        name: 'event.off', kind: 'write',
        desc: '删除触发器。',
        params: { id: '触发器 id' },
        run: a => removeTrigger(a),
    },
    {
        name: 'event.list', kind: 'read',
        desc: '列出所有触发器及其挂载状态，并给出可用事件名。',
        params: {},
        run: () => listTriggers(),
    },
    {
        name: 'persona.list', kind: 'read',
        desc: '列出全部用户人格（名字/头像/描述/是否当前），以及当前 {user} 名。',
        params: {},
        run: () => listPersonas(),
    },
    {
        name: 'persona.desc', kind: 'write',
        desc: '写人格描述并可选设置插入位置/深度/角色（{user} 宏内容）。',
        params: { text: '描述文本', name: '人格名，缺省=当前', position: '0=系统提示 1=聊天内', depth: '插入深度', role: '0系统 1用户 2AI' },
        run: a => setPersonaDesc(a),
    },
    {
        name: 'persona.switch', kind: 'write',
        desc: '切换当前用户人格。',
        params: { name: '人格名' },
        run: a => switchPersona(a),
    },
    {
        name: 'group.list', kind: 'read',
        desc: '列出群聊及其成员数、聊天文件、当前是否在群聊。',
        params: {},
        run: () => listGroups(),
    },
    {
        name: 'group.activate', kind: 'write',
        desc: '切换到指定群聊。',
        params: { id: '群 id', name: '或群名' },
        run: a => activateGroup(a),
    },
    {
        name: 'token.count', kind: 'read',
        desc: '用酒馆自己的分词器算 token 数（和上下文预算口径一致）。',
        params: { text: '待算文本' },
        run: a => countTokens(a),
    },
    {
        name: 'macro.expand', kind: 'read',
        desc: '展开酒馆宏（{{user}}/{{char}}/{{getvar::x}}/{{time}} 等），用于验证变量与宏是否生效。',
        params: { text: '含宏的文本' },
        run: a => expandMacros(a),
    },
    {
        name: 'gen.info', kind: 'read',
        desc: '查看当前 API、模型名、上下文预算、当前聊天楼层数。',
        params: {},
        run: () => genInfo(),
    },
    {
        name: 'gen.stop', kind: 'write',
        desc: '中断正在进行的生成。',
        params: {},
        run: () => stopGen(),
    },
    {
        name: 'lb.setGlobal', kind: 'write',
        desc: '把某本世界书设为全局激活（等同 /world 命令）。',
        params: { name: '世界书名' },
        run: a => setGlobalBook(a),
    },
    /* ---------- v1.3 ---------- */
    {
        name: 'qr.sets', kind: 'read',
        desc: '列出「快速回复」的所有组、哪些挂成了全局/聊天、以及所有 automationId（酒馆原生自动化钩子）。',
        params: {},
        run: () => qrSets(),
    },
    {
        name: 'qr.list', kind: 'read',
        desc: '列出某个快速回复组里的按钮，含它执行的 message 和自动触发钩子。',
        params: { set: '组名' },
        run: a => qrList(a),
    },
    {
        name: 'qr.createSet', kind: 'write',
        desc: '新建一个快速回复组并可立即挂上（global 全局 / chat 当前聊天）。',
        params: { name: '组名', mount: 'global|chat|none' },
        run: a => qrCreateSet(a),
    },
    {
        name: 'qr.add', kind: 'write',
        desc: '往组里加一个按钮。message 是 STscript（如 /echo hi 或 /setvar key=x）。on.* 可让它在 AI 回复后/生成前自动执行，automation_id 可被 /automation 触发。',
        params: { set: '组名', label: '按钮名', message: 'STscript', icon: '图标', show_label: '显示文字', automation_id: '自动化 id', on: '{ai,user,startup,new_chat,before_generation…}' },
        run: a => qrAdd(a),
    },
    {
        name: 'qr.delete', kind: 'write',
        desc: '删除组里的某个按钮。',
        params: { set: '组名', label: '按钮名' },
        run: a => qrDelete(a),
    },
    {
        name: 'qr.run', kind: 'write',
        desc: '立即执行某个按钮（等于手点它），返回 STscript 管道结果。',
        params: { set: '组名', label: '按钮名', args: '传给 STscript 的参数对象' },
        run: a => qrRun(a),
    },
    {
        name: 'chat.searchAll', kind: 'read',
        desc: '在角色（或群聊）的所有聊天文件里做全文搜索，返回命中的聊天文件与楼层。比只搜当前聊天有用得多。',
        params: { query: '关键词', group: '群 id（可选）' },
        run: a => searchAllChats(a),
    },
    {
        name: 'gen.raw', kind: 'write',
        desc: '用酒馆当前 API 跑一次独立生成，结果不进聊天（相当于「问另一个模型一句话」，可指定 system 与长度）。',
        params: { prompt: '用户侧文本', system: '系统提示（可选）', length: '最大输出 token' },
        run: a => genRaw(a),
    },
    {
        name: 'sampler.get', kind: 'read',
        desc: '读当前采样参数（temperature / top_p / penalties / max_tokens 等）。',
        params: {},
        run: () => samplerGet(),
    },
    {
        name: 'sampler.set', kind: 'write',
        desc: '改采样参数（只改传入的字段，其余不动），写完立即存盘。',
        params: { values: '{temperature:0.8, top_p:0.9, …}' },
        run: a => samplerSet(a),
    },
];

export function advToolByName(name) {
    return ADV_TOOLS.find(t => t.name === name) || null;
}

export function advToolsPrompt() {
    const th = helperInfo();
    const lines = ADV_TOOLS.map(t => `- ${t.name}（${t.kind}）：${t.desc}\n  参数：${Object.entries(t.params).map(([k, v]) => `${k} = ${v}`).join('；') || '无'}`);
    return [
        '',
        '## 进阶工具（变量 / 楼层 / 世界书条目 / 注入 / 正则 / 预设 / 脚本）',
        th.online ? `（检测到「酒馆助手」v${th.version}：script.* 可用）` : '（未安装「酒馆助手」：script.* 不可用，其余照常）',
        ...lines,
    ].join('\n');
}

export { helperInfo };
