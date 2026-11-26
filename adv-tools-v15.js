/**
 * v1.5 工具层：快速回复组的改写 / 挂载 / 右键菜单，以及「世界书条目 → automationId → 按钮」这条
 * 酒馆原生自动化链（AutoExecuteHandler.handleWIActivation），外加跨角色最近聊天与生成触发。
 *
 * 由 tools.js 末尾的探针加载器自动挂载（adv-tools-v14 / v15 … v19 已预置），无需改 index.js。
 */
import { getContext } from '../../../extensions.js';

const c = () => getContext();

/* ------------------------------ 基础 ------------------------------ */

async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { ...c().getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    return res;
}

function qrApi() {
    const api = globalThis.quickReplyApi;
    if (!api) throw new Error('没找到 quickReplyApi（酒馆「快速回复」扩展未启用）');
    return api;
}

function persist() {
    try {
        qrApi().settings?.save?.();
        c().saveSettingsDebounced?.();
    } catch { /* ignore */ }
}

/** 三层 QR 配置：全局塞进 settings.config，聊天级 chatConfig，角色级 charConfig */
function configs(api) {
    const s = api.settings || {};
    return [
        ['global', s.config],
        ['chat', s.chatConfig],
        ['character', s.charConfig],
    ].filter(([, cfg]) => cfg);
}

function qrOf(setName, label) {
    const api = qrApi();
    const qr = api.getQrByLabel(setName, label);
    if (!qr) throw new Error(`组「${setName}」里没有按钮「${label}」`);
    return qr;
}

function describeQr(qr) {
    return {
        label: qr.label,
        message: (qr.message || '').slice(0, 200),
        title: qr.title || '',
        icon: qr.icon || '',
        show_label: !!qr.showLabel,
        hidden: !!qr.isHidden,
        automation_id: qr.automationId || '',
        prevent_auto_execute: !!qr.preventAutoExecute,
        context_menu: (qr.contextList || []).length,
        on: {
            startup: !!qr.executeOnStartup,
            user: !!qr.executeOnUser,
            ai: !!qr.executeOnAi,
            chat_change: !!qr.executeOnChatChange,
            group_draft: !!qr.executeOnGroupMemberDraft,
            new_chat: !!qr.executeOnNewChat,
            before_generation: !!qr.executeBeforeGeneration,
        },
    };
}

/* ------------------------------ QR 改写 ------------------------------ */

function qrUpdate({ set, label, new_label, message, title, icon, show_label, hidden, automation_id, on } = {}) {
    if (!set || !label) throw new Error('需要 set 与 label');
    qrOf(set, label);
    const api = qrApi();
    const patch = {};
    if (new_label !== undefined) patch.newLabel = String(new_label);
    if (message !== undefined) patch.message = String(message);
    if (title !== undefined) patch.title = String(title);
    if (icon !== undefined) patch.icon = String(icon);
    if (show_label !== undefined) patch.showLabel = !!show_label;
    if (hidden !== undefined) patch.isHidden = !!hidden;
    if (automation_id !== undefined) patch.automationId = String(automation_id);
    if (on && typeof on === 'object') {
        const map = {
            startup: 'executeOnStartup', user: 'executeOnUser', ai: 'executeOnAi',
            chat_change: 'executeOnChatChange', group_draft: 'executeOnGroupMemberDraft',
            new_chat: 'executeOnNewChat', before_generation: 'executeBeforeGeneration',
        };
        for (const [k, v] of Object.entries(on)) {
            if (map[k]) patch[map[k]] = !!v;
        }
    }
    if (!Object.keys(patch).length) throw new Error('没有要改的字段');
    const qr = api.updateQuickReply(set, label, patch);
    persist();
    return { ok: true, set, ...describeQr(qr) };
}

/* ------------------------------ QR 挂载 ------------------------------ */

function qrMount({ set, target = 'global', visible = true } = {}) {
    if (!set) throw new Error('需要 set 名');
    const api = qrApi();
    if (!api.listSets().includes(set)) throw new Error(`没有名为「${set}」的组`);
    const snapshot = () => ({
        global: (api.listGlobalSets?.() || []).includes(set),
        chat: (api.listChatSets?.() || []).includes(set),
    });
    const before = snapshot();

    // 注意：toggleGlobalSet / toggleChatSet 的语义是「有则删、无则加」，不能用来“确保挂上”。
    // 统一改成「先移除（若已挂）再按指定可见性添加」，结果确定。
    if (target === 'none') {
        if (before.global) api.removeGlobalSet(set);
        if (before.chat) api.removeChatSet(set);
    } else if (target === 'global') {
        if (before.global) api.removeGlobalSet(set);
        api.addGlobalSet(set, !!visible);
    } else if (target === 'chat') {
        if (before.chat) api.removeChatSet(set);
        api.addChatSet(set, !!visible);
    } else {
        throw new Error('target 只能是 global / chat / none');
    }
    persist();
    const after = snapshot();
    return { ok: true, set, target, visible: !!visible, before, after, changed: before.global !== after.global || before.chat !== after.chat };
}

async function qrDeleteSet({ set } = {}) {
    if (!set) throw new Error('需要 set 名');
    const api = qrApi();
    if (!api.listSets().includes(set)) throw new Error(`没有名为「${set}」的组`);
    await api.deleteSet(set);
    persist();
    return { ok: true, deleted_set: set, remaining: api.listSets() };
}

function qrContext({ set, label, context_set, clear = false } = {}) {
    if (!set || !label) throw new Error('需要 set 与 label');
    qrOf(set, label);
    const api = qrApi();
    if (clear) {
        api.clearContextMenu(set, label);
        persist();
        return { ok: true, set, label, cleared: true };
    }
    if (!context_set) throw new Error('需要 context_set（当作子菜单的另一个组名）');
    if (!api.listSets().includes(context_set)) throw new Error(`没有名为「${context_set}」的组`);
    api.createContextItem(set, label, context_set);
    persist();
    const qr = api.getQrByLabel(set, label);
    return { ok: true, set, label, context_set, menus: (qr.contextList || []).map(l => l.set?.name).filter(Boolean) };
}

function qrExport({ set } = {}) {
    if (!set) throw new Error('需要 set 名');
    const api = qrApi();
    const s = api.getSetByName(set);
    if (!s) throw new Error(`没有名为「${set}」的组`);
    return {
        ok: true,
        set,
        name: s.name,
        disable_send: !!s.disableSend,
        place_before_input: !!s.placeBeforeInput,
        inject_input: !!s.injectInput,
        count: (s.qrList || []).length,
        replies: (s.qrList || []).map(describeQr),
    };
}

/* ------------------------------ 世界书 → automationId ------------------------------ */

async function lbSetAutomation({ name, uid, comment, automation_id } = {}) {
    if (!name) throw new Error('需要世界书名');
    if (automation_id === undefined) throw new Error('需要 automation_id（传空字符串即清除）');
    const data = await c().loadWorldInfo(name);
    if (!data?.entries) throw new Error(`世界书「${name}」不存在或没有条目`);
    let key = null;
    if (uid !== undefined && uid !== null && uid !== '' && data.entries[uid]) key = String(uid);
    else if (comment) {
        const hit = Object.entries(data.entries).find(([, e]) => e.comment === comment);
        if (hit) key = hit[0];
    }
    if (!key) throw new Error('找不到条目：给 uid 或准确的 comment');
    data.entries[key].automationId = String(automation_id);
    await c().saveWorldInfo(name, data, true);
    try { c().reloadWorldInfoEditor?.(name, true); } catch { /* ignore */ }
    return { ok: true, name, uid: Number(key), comment: data.entries[key].comment, automation_id: data.entries[key].automationId };
}

async function automationList({ scanWorlds = true, worldLimit = 20 } = {}) {
    const api = qrApi();

    // 只有挂在 global / chat / character 三层配置里的组，才会被 AutoExecuteHandler 执行；
    // 未挂载的组即使写了 automationId 也不会触发，所以这里如实标注 scope = unmounted。
    const scopeOf = new Map();
    for (const [scope, cfg] of configs(api)) {
        for (const link of (cfg.setList || [])) {
            if (link.set) scopeOf.set(link.set.name, scope);
        }
    }

    const buttons = [];
    for (const name of api.listSets()) {
        const set = api.getSetByName?.(name);
        if (!set) continue;
        const scope = scopeOf.get(name) || 'unmounted';
        for (const qr of (set.qrList || [])) {
            if (!qr.automationId) continue;
            buttons.push({
                automation_id: qr.automationId,
                scope,
                active: scope !== 'unmounted',
                set: name,
                label: qr.label,
                message: (qr.message || '').slice(0, 160),
            });
        }
    }

    const entries = [];
    if (scanWorlds) {
        const names = (c().getWorldInfoNames?.() || []).slice(0, Number(worldLimit) || 20);
        for (const wname of names) {
            let data = null;
            try { data = await c().loadWorldInfo(wname); } catch { continue; }
            for (const e of Object.values(data?.entries || {})) {
                if (!e.automationId) continue;
                entries.push({
                    world: wname,
                    uid: e.uid,
                    comment: e.comment,
                    keys: e.key,
                    enabled: !e.disable,
                    automation_id: e.automationId,
                    has_active_button: buttons.some(b => b.automation_id === e.automationId && b.active),
                });
            }
        }
    }

    const ids = new Set([...buttons.map(b => b.automation_id), ...entries.map(e => e.automation_id)]);
    const unmatched = [...ids].filter(id =>
        !buttons.some(b => b.automation_id === id && b.active) || !entries.some(e => e.automation_id === id));
    const dormant = buttons.filter(b => !b.active);

    return {
        automation_ids: ids.size,
        buttons: buttons.length,
        active_buttons: buttons.length - dormant.length,
        entries: entries.length,
        unmatched_ids: unmatched,
        dormant_buttons: dormant,
        buttons_list: buttons,
        entries_list: entries,
        hint: '世界书条目命中时，AutoExecuteHandler 用该条目的 automationId 找同 id 且已挂载的按钮执行。dormant_buttons = 配了 id 但没挂载，永远不会触发（用 qr.mount 挂上）；unmatched_ids = 有一边没配对。',
    };
}

async function automationRun({ automation_id, args = {}, includeDormant = false } = {}) {
    if (!automation_id) throw new Error('需要 automation_id');
    const api = qrApi();
    const scopeOf = new Map();
    for (const [scope, cfg] of configs(api)) {
        for (const link of (cfg.setList || [])) {
            if (link.set) scopeOf.set(link.set.name, scope);
        }
    }
    const targets = [];
    const dormant = [];
    for (const name of api.listSets()) {
        const set = api.getSetByName?.(name);
        if (!set) continue;
        const scope = scopeOf.get(name) || 'unmounted';
        for (const qr of (set.qrList || [])) {
            if (qr.automationId !== automation_id) continue;
            const item = { scope, active: scope !== 'unmounted', set: name, label: qr.label };
            if (item.active) targets.push(item);
            else dormant.push(item);
        }
    }
    if (!targets.length) {
        const tail = dormant.length
            ? `；有 ${dormant.length} 个同 id 按钮但未挂载（${dormant.map(d => `${d.set}/${d.label}`).join('、')}），先用 qr.mount 挂上`
            : '，也没有未挂载的同 id 按钮';
        throw new Error(`没有已挂载的按钮 automationId 等于「${automation_id}」${tail}`);
    }
    if (includeDormant) targets.push(...dormant.map(d => ({ ...d, active: false })));
    const results = [];
    for (const t of targets) {
        try {
            const r = await api.executeQuickReply(t.set, t.label, args);
            results.push({ ...t, ok: true, result: typeof r === 'string' ? r.slice(0, 1000) : (r?.pipe ?? null) });
        } catch (error) {
            results.push({ ...t, ok: false, error: String(error?.message || error) });
        }
    }
    return { ok: true, automation_id, fired: results.length, dormant: dormant.length, results };
}

/* ------------------------------ 跨角色聊天 / 生成 ------------------------------ */

async function chatRecent({ limit = 20 } = {}) {
    // 端点返回的是 getChatInfo() 结果（file_name / avatar / last_mes），顺序已按 mtime 倒序；max 由 body.max 控制
    const max = Number(limit) || 20;
    const res = await postJson('/api/chats/recent', { pinned: [], max, metadata: true });
    if (!res.ok) throw new Error(`读取最近聊天失败：HTTP ${res.status}`);
    const list = await res.json().catch(() => []);
    if (!Array.isArray(list)) throw new Error('返回结构不是数组');
    const rows = list
        .filter(x => x && (x.file_name || x.fileName))
        .map(x => ({
            file: x.file_name || x.fileName,
            avatar: x.avatar || null,
            group_id: x.group || null,
            messages: x.chat_items ?? x.message_count ?? null,
            last_mes: x.last_mes || null,
            preview: (x.mes || x.preview || '').slice(0, 80),
        }));
    return { count: rows.length, order: 'mtime 倒序（服务端已排好）', chats: rows.slice(0, max) };
}

async function slash(cmd) {
    const x = c();
    if (typeof x.executeSlashCommandsWithOptions !== 'function') throw new Error('当前版本不支持执行 slash 命令');
    const r = await x.executeSlashCommandsWithOptions(cmd, { showOutput: false });
    return { ok: true, command: cmd, result: r?.pipe ?? (typeof r === 'string' ? r : null) };
}

async function msgTrigger({ prompt } = {}) {
    const cmd = prompt ? `/trigger ${prompt}` : '/trigger';
    return slash(cmd);
}

async function msgContinue() {
    return slash('/continue');
}

/* ------------------------------ 导出 ------------------------------ */

export const TOOLS = [
    {
        name: 'qr.update', kind: 'write',
        desc: '原位改写一个已有按钮（不用删了重建）：改 message / 图标 / 文字 / 隐藏 / automation_id，或翻转 on 里的任意钩子。只传要改的字段。',
        params: {
            set: '组名', label: '按钮名',
            new_label: '改名', message: '新 STscript', title: '悬停提示', icon: '图标',
            show_label: '是否显示文字', hidden: '是否隐藏', automation_id: '自动化 id（传空串=清空）',
            on: '{startup,user,ai,chat_change,group_draft,new_chat,before_generation} 里的任意子集',
        },
        run: a => qrUpdate(a),
    },
    {
        name: 'qr.mount', kind: 'write',
        desc: '把快速回复组挂到全局 / 当前聊天，或 target=none 全部卸下；visible=false 只挂不显示（仍可被 automationId 命中执行）。',
        params: { set: '组名', target: 'global|chat|none', visible: '是否显示，默认 true' },
        run: a => qrMount(a),
    },
    {
        name: 'qr.deleteSet', kind: 'dangerous',
        desc: '删掉整个快速回复组（按钮一起消失）。',
        params: { set: '组名' },
        run: a => qrDeleteSet(a),
    },
    {
        name: 'qr.context', kind: 'write',
        desc: '给按钮加/清右键子菜单：context_set 是「当作子菜单」的另一个组名；clear=true 清空该按钮的所有子菜单。',
        params: { set: '按钮所在的组', label: '按钮名', context_set: '子菜单组名', clear: 'true 清空' },
        run: a => qrContext(a),
    },
    {
        name: 'qr.export', kind: 'read',
        desc: '把一个快速回复组导出成结构化 JSON（含每个按钮的 message 与全部钩子），用于备份、迁移到别的酒馆实例。',
        params: { set: '组名' },
        run: a => qrExport(a),
    },
    {
        name: 'lb.setAutomation', kind: 'write',
        desc: '给世界书条目设（或清空）automationId。之后该条目被激活时，酒馆会自动执行同 automationId 的快速回复按钮——这是酒馆原生的「世界书驱动自动化」，比外部事件监听可靠。字段写的是 entry.automationId（UI 里显示为 automation_id）。',
        params: { name: '世界书名', uid: '条目 uid', comment: '或用条目标题定位', automation_id: '要绑定的 id，传空串清除' },
        run: a => lbSetAutomation(a),
    },
    {
        name: 'automation.list', kind: 'read',
        desc: '把「按钮的 automationId」和「世界书条目的 automationId」拉到一张表里对照，并给出 unmatched_ids（有一边没配上的 id）。配自动化之前先看这个。',
        params: { scanWorlds: '是否扫世界书，默认 true', worldLimit: '最多扫几本世界书，默认 20' },
        run: a => automationList(a),
    },
    {
        name: 'automation.run', kind: 'write',
        desc: '立刻按 automationId 触发所有同 id 且已挂载的按钮（等于模拟一次世界书命中），返回每个按钮的 STscript 管道结果。可以不真跑世界书就验证自动化链。',
        params: { automation_id: 'id', args: '传给 STscript 的管道参数对象', includeDormant: '连未挂载的也强行执行，默认 false' },
        run: a => automationRun(a),
    },
    {
        name: 'chat.recent', kind: 'read',
        desc: '跨角色列出最近改动的聊天档（含群聊），按 mtime 倒序。想找「最近玩过哪几档」用它，不用先选角色。',
        params: { limit: '返回条数，默认 20（对应端点 body.max）' },
        run: a => chatRecent(a),
    },
    {
        name: 'msg.trigger', kind: 'write',
        desc: '触发一次 AI 回复（等同 /trigger）。传 prompt 会先塞一句再触发。会消耗 API 额度。',
        params: { prompt: '可选，先插入的内容' },
        run: a => msgTrigger(a),
    },
    {
        name: 'msg.continue', kind: 'write',
        desc: '让 AI 接着上一条继续说（等同 /continue）。会消耗 API 额度。',
        params: {},
        run: () => msgContinue(),
    },
];
