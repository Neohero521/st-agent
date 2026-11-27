/**
 * v1.6 工具层：直连「酒馆助手」(JS-Slash-Runner) 的 TavernHelper 全局。
 *
 * 这一层不是在模拟酒馆，而是借用酒馆助手的**高层 API**去做原生扩展拿不到的三件事：
 *   1) 预设提示词的逐条编辑（PromptManager 没暴露到 getContext，只有酒馆助手把它包了出来）
 *   2) 世界书的绑定关系（角色主/附加世界书、聊天级世界书、lorebook 全局设置）
 *   3) 楼层重排、渲染态文本、从 JSON 字符串直接导入资产
 *
 * 没装酒馆助手时这些工具仍会出现在列表里，但调用会明确报「请先安装酒馆助手」，不会静默失效。
 */
import { getContext } from '../../../extensions.js';

const c = () => getContext();

/* ------------------------------ 基础 ------------------------------ */

function th() {
    const api = globalThis.TavernHelper;
    if (!api) throw new Error('没找到 TavernHelper：需要先装「酒馆助手」(JS-Slash-Runner 4.x) 并刷新页面');
    return api;
}

function thHas(name) {
    return typeof globalThis.TavernHelper?.[name] === 'function';
}

function promptBrief(p, limit) {
    return {
        id: String(p.id),
        name: p.name,
        enabled: !!p.enabled,
        role: p.role,
        position: p.position ? (p.position.type === 'in_chat'
            ? `in_chat d${p.position.depth} o${p.position.order}`
            : 'relative') : '(占位符)',
        chars: (p.content || '').length,
        content: (p.content || '').slice(0, limit),
    };
}

function findPrompt(preset, key) {
    return preset.prompts.find(x => String(x.id) === String(key))
        || preset.prompts.find(x => x.name === key)
        || preset.prompts_unused.find(x => String(x.id) === String(key))
        || preset.prompts_unused.find(x => x.name === key);
}

/* ------------------------------ 酒馆助手状态 ------------------------------ */

function thStatus() {
    const api = globalThis.TavernHelper;
    if (!api) {
        return { ok: false, installed: false, hint: '装上 JS-Slash-Runner 4.x 后刷新页面，这一层的工具才会生效；其余 104 个工具不受影响。' };
    }
    const keys = Object.keys(api);
    const groups = {
        preset: keys.filter(k => /Preset/i.test(k)),
        lorebook: keys.filter(k => /Lorebook|Worldbook/i.test(k)),
        chat_message: keys.filter(k => /ChatMessage|ChatMessages|rotateChat/i.test(k)),
        variables: keys.filter(k => /Variable/i.test(k)),
        generate: keys.filter(k => /generate|ModelList|Generation/i.test(k)),
        regex: keys.filter(k => /TavernRegex|RegexedString/i.test(k)),
        import: keys.filter(k => /importRaw|replaceCharacter|createCharacter|deleteCharacter/i.test(k)),
        extension: keys.filter(k => /Extension/i.test(k)),
    };
    return {
        ok: true,
        installed: true,
        version: api.getTavernHelperVersion?.() ?? null,
        st_version: api.getTavernVersion?.() ?? null,
        frontend_version: api.getFrontendVersion?.() ?? null,
        methods: keys.length,
        groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
        sample: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.slice(0, 6)])),
    };
}

/* ------------------------------ 预设提示词 ------------------------------ */

function presetPrompts({ name = 'in_use', contentLimit = 80, includeUnused = true } = {}) {
    const api = th();
    const preset = api.getPreset(name);
    const limit = Math.max(0, Number(contentLimit) || 0);
    return {
        ok: true,
        preset: name,
        loaded_preset: api.getLoadedPresetName?.() ?? null,
        total: preset.prompts.length + (preset.prompts_unused?.length || 0),
        budget: {
            max_context: preset.settings?.max_context,
            max_completion_tokens: preset.settings?.max_completion_tokens,
            temperature: preset.settings?.temperature,
            top_p: preset.settings?.top_p,
        },
        prompts: preset.prompts.map(p => promptBrief(p, limit)),
        unused: includeUnused ? (preset.prompts_unused || []).map(p => promptBrief(p, limit)) : undefined,
        hint: '标识（id）就是 order 里用的 identifier；in_chat 的提示词靠 depth + order 决定插入位置，relative 的靠列表顺序。',
    };
}

async function presetPromptEdit({
    name = 'in_use', id, prompt_name, content, enabled, role,
    position, depth, order, field,
} = {}) {
    if (!id && !prompt_name) throw new Error('需要 id 或 prompt_name');
    const patch = {};
    if (content !== undefined) patch.content = String(content);
    if (enabled !== undefined) patch.enabled = !!enabled;
    if (role !== undefined) patch.role = String(role);
    if (prompt_name !== undefined) patch.name = String(prompt_name);

    if (position !== undefined || depth !== undefined || order !== undefined) {
        const type = position || (depth !== undefined || order !== undefined ? 'in_chat' : null);
        if (type === 'relative') patch.position = { type: 'relative' };
        else if (type === 'in_chat') patch.position = {
            type: 'in_chat',
            depth: Number(depth ?? 4),
            order: Number(order ?? 100),
        };
    }
    if (!Object.keys(patch).length) throw new Error('没有要改的字段');

    const api = th();
    let before = null;
    let after = null;
    await api.updatePresetWith(name, preset => {
        const target = findPrompt(preset, id || prompt_name);
        if (!target) throw new Error(`预设「${name}」里找不到提示词「${id || prompt_name}」`);
        before = promptBrief(target, 200);
        Object.assign(target, patch);
        after = promptBrief(target, 200);
        return preset;
    }, { render: 'debounced' });
    return { ok: true, preset: name, before, after };
}

async function presetPromptAdd({
    name = 'in_use', prompt_name, content = '', role = 'system',
    position = 'in_chat', depth = 4, order = 100, id,
} = {}) {
    if (!prompt_name) throw new Error('需要 prompt_name（显示名）');
    const api = th();
    const newId = id || (globalThis.crypto?.randomUUID?.() ?? `stagent_${Date.now()}`);
    let added = null;
    await api.updatePresetWith(name, preset => {
        if (preset.prompts.some(x => String(x.id) === String(newId))) throw new Error(`提示词 id「${newId}」已存在`);
        const item = {
            id: newId,
            name: String(prompt_name),
            enabled: true,
            role: String(role),
            content: String(content),
            position: position === 'relative' ? { type: 'relative' } : { type: 'in_chat', depth: Number(depth), order: Number(order) },
        };
        preset.prompts.push(item);
        added = promptBrief(item, 200);
        return preset;
    }, { render: 'debounced' });
    return { ok: true, preset: name, added };
}

async function presetPromptRemove({ name = 'in_use', id, prompt_name } = {}) {
    if (!id && !prompt_name) throw new Error('需要 id 或 prompt_name');
    const api = th();
    let removed = null;
    await api.updatePresetWith(name, preset => {
        const target = findPrompt(preset, id || prompt_name);
        if (!target) throw new Error(`预设「${name}」里找不到提示词「${id || prompt_name}」`);
        removed = promptBrief(target, 120);
        preset.prompts = preset.prompts.filter(x => x !== target);
        preset.prompts_unused = (preset.prompts_unused || []).filter(x => x !== target);
        return preset;
    }, { render: 'debounced' });
    return { ok: true, preset: name, removed };
}

async function presetPromptOrder({ name = 'in_use', orders = {}, enabled = {}, sequence } = {}) {
    const api = th();
    let changed = 0;
    await api.updatePresetWith(name, preset => {
        if (Array.isArray(sequence) && sequence.length) {
            const byKey = key => preset.prompts.find(x => String(x.id) === String(key)) || preset.prompts.find(x => x.name === key);
            const picked = sequence.map(byKey).filter(Boolean);
            const rest = preset.prompts.filter(x => !picked.includes(x));
            preset.prompts = [...picked, ...rest];
            changed += picked.length;
        }
        for (const [key, value] of Object.entries(orders || {})) {
            const target = preset.prompts.find(x => String(x.id) === String(key)) || preset.prompts.find(x => x.name === key);
            if (!target) continue;
            if (!target.position || target.position.type !== 'in_chat') target.position = { type: 'in_chat', depth: 4, order: Number(value) };
            else target.position.order = Number(value);
            changed += 1;
        }
        for (const [key, value] of Object.entries(enabled || {})) {
            const target = preset.prompts.find(x => String(x.id) === String(key)) || preset.prompts.find(x => x.name === key);
            if (!target) continue;
            target.enabled = !!value;
            changed += 1;
        }
        return preset;
    }, { render: 'debounced' });
    return { ok: true, preset: name, changed, prompts: th().getPreset(name).prompts.map(p => promptBrief(p, 0)) };
}

/* ------------------------------ 世界书绑定 ------------------------------ */

async function loreBind({ role = 'character', primary, additional, name } = {}) {
    const api = th();
    if (role === 'character') {
        if (primary === undefined && additional === undefined) {
            return { ok: true, role, current: api.getCharLorebooks?.({ name: 'current' }) ?? null };
        }
        const patch = {};
        if (primary !== undefined) patch.primary = primary || null;
        if (additional !== undefined) patch.additional = Array.isArray(additional) ? additional : [additional].filter(Boolean);
        await api.setCurrentCharLorebooks(patch);
        return { ok: true, role, applied: patch, current: api.getCharLorebooks?.({ name: 'current' }) ?? null };
    }
    if (role === 'chat') {
        // 聊天级世界书挂在 chat_metadata 上，没加载聊天时酒馆会直接抛错 —— 包成结构化返回，别让 Agent 看到裸异常。
        try {
            if (name === undefined && primary === undefined) {
                return { ok: true, role, current: api.getChatLorebook?.() ?? null };
            }
            const target = (name ?? primary) || null;
            await api.setChatLorebook(target);
            return { ok: true, role, current: api.getChatLorebook?.() ?? null };
        } catch (error) {
            return { ok: false, role, reason: String(error?.message || error), hint: '先选中角色卡并打开一档聊天，聊天级世界书才有落点。' };
        }
    }
    if (role === 'chatCreate') {
        try {
            const created = await api.getOrCreateChatLorebook(name || undefined);
            return { ok: true, role, current: created };
        } catch (error) {
            return { ok: false, role, reason: String(error?.message || error), hint: '先选中角色卡并打开一档聊天。' };
        }
    }
    throw new Error('role 只能是 character / chat / chatCreate');
}

function loreSettings({ set } = {}) {
    const api = th();
    if (!set) return { ok: true, settings: api.getLorebookSettings?.() ?? null };
    api.setLorebookSettings(set);
    return { ok: true, applied: set, settings: api.getLorebookSettings?.() ?? null };
}

/* ------------------------------ 楼层与渲染 ------------------------------ */

async function msgRotate({ begin, middle, end, refresh = 'affected' } = {}) {
    if (begin === undefined || middle === undefined || end === undefined) throw new Error('需要 begin / middle / end 三个楼层号');
    await th().rotateChatMessages(Number(begin), Number(middle), Number(end), { refresh });
    const chat = c().chat || [];
    return {
        ok: true,
        rotated: { begin: Number(begin), middle: Number(middle), end: Number(end) },
        chat_length: chat.length,
        order: chat.slice(Number(begin), Number(end) + 1).map(m => ({
            role: m.is_user ? 'user' : (m.is_system ? 'system' : 'char'),
            preview: String(m.mes || '').slice(0, 40),
        })),
    };
}

function msgRender({ text, message_id = 'last' } = {}) {
    if (typeof text !== 'string') throw new Error('需要 text');
    const x = c();
    // 两步走：先让酒馆展开宏与变量（substituteParams，和生成时同一套），
    // 再交给酒馆助手的显示层格式化套正则与 markdown —— 只靠后者的话宏不会被展开。
    const expanded = typeof x.substituteParams === 'function'
        ? String(x.substituteParams(text, x.name1, x.name2) ?? text)
        : text;
    let html = null;
    try { html = th().formatAsDisplayedMessage(expanded, { message_id }); } catch { /* 无消息楼层时只给展开结果 */ }
    return {
        ok: true,
        input_chars: text.length,
        expanded,
        expanded_chars: expanded.length,
        rendered_html: html,
        hint: 'expanded 是宏与变量展开后的纯文本（{{user}}/{{char}}/{{getvar::}}/{{time}} 等），rendered_html 再叠加酒馆已启用的正则与 markdown，等于屏幕上最终的样子。',
    };
}

/* ------------------------------ 原始导入 ------------------------------ */

async function importRaw({ kind, name, content } = {}) {
    if (!kind) throw new Error('需要 kind：character / worldbook / preset / regex / chat');
    if (!name) throw new Error('需要 name（导入后的文件名）');
    if (typeof content !== 'string' || !content.trim()) throw new Error('需要 content（JSON 或 JSONL 字符串）');
    const api = th();

    switch (kind) {
        case 'character': {
            const blob = new Blob([content], { type: 'application/json' });
            const res = await api.importRawCharacter(name, blob);
            return { ok: !!res?.ok, kind, name, http: res?.status ?? null, hint: '导入后酒馆会重新加载角色列表，卡已可直接使用。' };
        }
        case 'worldbook': {
            const done = await api.importRawWorldbook(name, content);
            return { ok: !!done, kind, name, hint: '文件已写到 worlds/ 目录；世界书面板与部分缓存要重进一次才刷新出新名字，world.list 读的是酒馆内存缓存。' };
        }
        case 'preset': {
            const done = await api.importRawPreset(name, content);
            return { ok: !!done, kind, name };
        }
        case 'regex': {
            const done = api.importRawTavernRegex(name, content);
            return { ok: !!done, kind, name };
        }
        case 'chat': {
            const res = await api.importRawChat(name, content);
            return { ok: !!res?.ok, kind, name, http: res?.status ?? null };
        }
        default:
            throw new Error('kind 只能是 character / worldbook / preset / regex / chat');
    }
}

/* ------------------------------ 模型 ------------------------------ */

async function genModels({ apiurl, key, presetProxy } = {}) {
    const api = th();
    const proxies = api.getProxyPresetNames?.() ?? [];
    if (!apiurl) {
        const x = c();
        return {
            ok: true,
            need_apiurl: true,
            preset_proxies: proxies,
            current_model: x.oai_settings?.openai_model ?? null,
            current_source: x.oai_settings?.chat_completion_source ?? null,
            hint: '传 apiurl（OpenAI 兼容端点，如 https://api.openai.com/v1）即可列出该端点可用模型；预设反代名见 preset_proxies。',
        };
    }
    const models = await api.getModelList({ apiurl: String(apiurl), key: key ? String(key) : undefined });
    return { ok: true, apiurl, count: models?.length ?? 0, models: (models || []).slice(0, 200), preset_proxies: proxies };
}

/* ------------------------------ 导出 ------------------------------ */

export const TOOLS = [
    {
        name: 'th.status', kind: 'read',
        desc: '检查「酒馆助手」(JS-Slash-Runner) 是否在线、版本号、暴露了多少方法，以及预设/世界书/楼层/变量/生成/正则/导入/扩展各组的可用数量。这一层工具用之前先看这个。',
        params: {},
        run: () => thStatus(),
    },
    {
        name: 'preset.prompts', kind: 'read',
        desc: '列出预设里的全部提示词（含未启用区）：id / 显示名 / 是否启用 / role / 插入位置（in_chat 的 depth+order 或 relative）/ 字符数 / 正文前若干字。改预设前先看清楚。',
        params: { name: '预设名，默认 in_use（当前生效的）', contentLimit: '正文预览字数，默认 80，传 0 只给统计', includeUnused: '是否包含未启用区，默认 true' },
        run: a => presetPrompts(a),
    },
    {
        name: 'preset.promptEdit', kind: 'write',
        desc: '改一条预设提示词：正文 / 启用状态 / role / 显示名 / 插入位置（type=in_chat 时配 depth 与 order）。酒馆的 PromptManager 只对 UI 开放，这是程序化改提示词的唯一通路，改完立即落盘。',
        params: { name: '预设名，默认 in_use', id: '提示词 id（就是 order 里的 identifier）', prompt_name: '或用显示名定位', content: '新正文', enabled: '是否启用', role: 'system|user|assistant', position: 'relative|in_chat', depth: 'in_chat 的深度', order: 'in_chat 的顺序值' },
        run: a => presetPromptEdit(a),
    },
    {
        name: 'preset.promptAdd', kind: 'write',
        desc: '往预设里加一条提示词（默认 in_chat 深度 4 顺序 100，system）。id 不给就自动生成 uuid。',
        params: { name: '预设名', prompt_name: '显示名（必填）', content: '正文', role: '默认 system', position: 'relative|in_chat', depth: '默认 4', order: '默认 100', id: '自定义 id' },
        run: a => presetPromptAdd(a),
    },
    {
        name: 'preset.promptRemove', kind: 'dangerous',
        desc: '从预设里删掉一条提示词（启用区与未启用区一起清）。删之前建议先 preset.prompts 确认 id。',
        params: { name: '预设名', id: '提示词 id', prompt_name: '或用显示名' },
        run: a => presetPromptRemove(a),
    },
    {
        name: 'preset.promptOrder', kind: 'write',
        desc: '批量调顺序与启停：orders 按 id→order 值写（只对 in_chat 生效）、enabled 按 id→布尔、sequence 给出一个 id 列表则按该顺序重排相对位置提示词。',
        params: { name: '预设名', orders: '{id: order}', enabled: '{id: true/false}', sequence: '[id, id, ...] 相对位置重排' },
        run: a => presetPromptOrder(a),
    },
    {
        name: 'lore.bind', kind: 'write',
        desc: '绑世界书：role=character 设当前角色的主世界书（primary）与附加世界书（additional，传数组即全量替换）；role=chat 设当前聊天的专属世界书（传空即解除）；role=chatCreate 没有就建一个。不传参则只回读当前绑定。',
        params: { role: 'character|chat|chatCreate', primary: '主世界书名', additional: '附加世界书名数组', name: 'chat/chatCreate 用' },
        run: a => loreBind(a),
    },
    {
        name: 'lore.settings', kind: 'write',
        desc: '读写世界书的全局设置（扫描深度、预算百分比、是否允许扫描、递归等）。不传 set 只读。',
        params: { set: '要改的字段对象，如 {depth: 4, budget: 25, scan: true}' },
        run: a => loreSettings(a),
    },
    {
        name: 'msg.rotate', kind: 'write',
        desc: '把 [middle,end) 段整体搬到 begin 前面，实现楼层重排（酒馆原生没暴露这个操作）。改完会刷新受影响的楼层。',
        params: { begin: '起点楼层', middle: '中段起点', end: '终点楼层（不含）', refresh: 'affected|none|all' },
        run: a => msgRotate(a),
    },
    {
        name: 'msg.render', kind: 'read',
        desc: '把一段文本按酒馆当前规则渲染成「最终显示态」：宏展开、变量替换、全局/角色/预设正则全部套用。调正则和宏时先拿它验结果，不用真发一条消息。',
        params: { text: '要渲染的文本', message_id: 'last|last_user|last_char|楼层号，默认 last' },
        run: a => msgRender(a),
    },
    {
        name: 'import.raw', kind: 'write',
        desc: '从 JSON / JSONL 字符串直接导入资产，不需要先落盘再上传：character（角色卡 JSON，走 /api/characters/import）、worldbook、preset、regex、chat（JSONL）。',
        params: { kind: 'character|worldbook|preset|regex|chat', name: '导入后的文件名', content: '完整 JSON / JSONL 字符串' },
        run: a => importRaw(a),
    },
    {
        name: 'gen.models', kind: 'read',
        desc: '列模型：不传 apiurl 时回当前模型 / 当前源 / 预设反代名清单；传 apiurl（OpenAI 兼容端点）则拉该端点可用模型列表。配模型、查可用模型名用它。',
        params: { apiurl: 'OpenAI 兼容端点，如 https://api.openai.com/v1', key: '可选密钥', presetProxy: '预留' },
        run: a => genModels(a),
    },
];
