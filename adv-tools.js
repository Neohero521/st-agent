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
