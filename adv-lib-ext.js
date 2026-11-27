import { getContext } from '../../../extensions.js';
import { c, participants, indexOfId, roleOf, msgVars, parseValue, stringifyValue, persistChat, refreshMessage, varStore, readVar, writeVar, deleteVar, describeMessage, getMessages, setMessage, createMessage, deleteMessages, swipeMessage } from './adv-lib-core.js';
import { entryFields, loadBook, getEntries, setEntry, deleteEntry, bindChatBook, POSITIONS, ROLES, setInject, clearInject, listInject } from './adv-lib-world.js';
import { branchChatAt, renameChatTo, attachedTriggers, triggerList, detachTrigger, attachTrigger, addTrigger, removeTrigger, listTriggers, personaAvatar, listPersonas, setPersonaDesc, switchPersona, listGroups, activateGroup, countTokens, expandMacros, genInfo, stopGen, setGlobalBook, qrApi, persistQuickReplies, qrSets, qrList, qrCreateSet, qrAdd, qrDelete, qrRun, searchAllChats, genRaw, SAMPLER_KEYS, samplerStore, samplerGet, samplerSet } from './adv-lib-aux.js';

export function allRegexes() {
    const out = [];
    const list = c().extensionSettings?.regex || [];
    for (const r of list) out.push({ source: 'global', ...r });
    const ch = c().characters?.[c().characterId];
    const cr = ch?.data?.extensions?.regex_scripts || [];
    for (const r of cr) out.push({ source: 'character', ...r });
    return out;
}

export function buildRegExp(pattern) {
    const s = String(pattern ?? '');
    const m = /^\/([\s\S]*)\/([gimsuy]*)$/.exec(s.trim());
    if (m) {
        try { return new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g'); } catch { return null; }
    }
    try { return new RegExp(s, 'g'); } catch { return null; }
}

export function testRegex({ id, text = '' } = {}) {
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

export function setRegexEnabled({ id, enabled = true } = {}) {
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

export async function loadPreset({ name, api = 'openai' } = {}) {
    if (!name) throw new Error('需要预设名字');
    const pm = c().getPresetManager?.(api);
    if (!pm) throw new Error(`没有 api=${api} 的预设管理器（可用 openai / textgeneration / instruct …）`);
    await pm.selectPreset(name);
    return { ok: true, api, preset: name };
}

export function listPresets({ api = 'openai' } = {}) {
    const pm = c().getPresetManager?.(api);
    if (!pm) throw new Error(`没有 api=${api} 的预设管理器`);
    const data = pm.getPresetList?.() || {};
    return { api, count: (data.preset_names || []).length, presets: data.preset_names || [] };
}

export function setPersona({ text } = {}) {
    const pu = c().powerUserSettings;
    if (!pu) throw new Error('当前版本没有 powerUserSettings');
    pu.persona_description = String(text ?? '');
    c().saveSettingsDebounced?.();
    return { ok: true, chars: pu.persona_description.length };
}

/* ------------------------------ 酒馆助手（可选） ------------------------------ */

export function helper() {
    return globalThis.TavernHelper || window.TavernHelper || null;
}

export function helperInfo() {
    const th = helper();
    if (!th) return { online: false };
    let version = '?';
    try { version = th.getTavernHelperVersion?.() ?? '?'; } catch { /* ignore */ }
    return { online: true, version };
}

export function listScripts({ scope = 'global' } = {}) {
    const th = helper();
    if (!th?.getScriptTrees) throw new Error('需要安装「酒馆助手」(JS-Slash-Runner) 4.x');
    // JSR 4.12 的 getScriptTrees 必须带 {type}，不传返回 undefined（不是空数组），
    // 旧实现直接 .map 就炸 TypeError: reading 'type'。
    let trees;
    try { trees = th.getScriptTrees({ type: scope }); } catch { trees = th.getScriptTrees(); }
    const flat = [];
    const walk = (arr) => (Array.isArray(arr) ? arr : []).forEach(t => {
        if (t?.type === 'folder') {
            flat.push({ name: t.name, type: 'folder', count: (t.scripts || []).length });
            walk(t.scripts);
        } else {
            flat.push({ name: t.name, type: t.type || 'script', enabled: t.enabled, id: t.id });
        }
    });
    walk(trees);
    return { scope, count: flat.length, scripts: flat };
}

/**
 * 写入「酒馆助手」脚本（v1.11 修正）。
 *
 * 旧实现四个硬 bug（对照 JS-Slash-Runner 4.12 源码 src/type/scripts.ts + src/function/script.ts）：
 *   1. 字段名用 code，实际是 content —— ScriptTree.parse 会丢弃未知键，脚本内容变成空；
 *   2. buttons: []，实际是 button:{enabled, buttons} —— 按钮结构丢失；
 *   3. stripId 抹掉 id —— 每次保存都重新生成 uuid，JSR 里 iframe runtime / 按钮绑定全断；
 *   4. getScriptTrees()/replaceScriptTrees() 不传 {type} —— 后者是必填参数，仓库版直接 TypeError。
 */
export function setScript({ name, code, enabled = true, scope = 'global' } = {}) {
    const th = helper();
    if (!th?.getScriptTrees || !th?.replaceScriptTrees) throw new Error('需要安装「酒馆助手」(JS-Slash-Runner) 4.x');
    if (!name) throw new Error('需要脚本名');

    const option = { type: scope };
    let trees;
    try { trees = th.getScriptTrees(option) || []; } catch { trees = th.getScriptTrees() || []; }

    const mkId = () => globalThis.crypto?.randomUUID?.() ?? `st-agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let found = null;

    const patchScript = s => {
        if (s?.name !== name) return s;
        found = s;
        return { ...s, content: code !== undefined ? String(code) : (s.content ?? ''), enabled: !!enabled };
    };

    const next = trees.map(t => {
        if (t?.type === 'folder') return { ...t, scripts: (t.scripts || []).map(patchScript) };
        return patchScript(t);
    });

    if (!found) {
        next.push({
            type: 'script',
            enabled: !!enabled,
            name,
            id: mkId(),
            content: String(code ?? ''),
            info: '',
            button: { enabled: true, buttons: [] },
            data: {},
            export_with: { data: true, button: true },
        });
    }

    try { th.replaceScriptTrees(next, option); } catch { th.replaceScriptTrees(next); }
    return { ok: true, name, scope, action: found ? 'updated' : 'created', total: next.length };
}

/* ------------------------------ v1.2：分支 / 事件触发器 / 人格 / 群聊 / 宏 ------------------------------ */

export let scriptMod;

export async function getScriptModule() {
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
