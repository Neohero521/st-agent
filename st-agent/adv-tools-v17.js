/**
 * v1.7 工具层：群聊的完整 CRUD、角色卡内嵌世界书的抽取，以及一次性的「酒馆体检」。
 *
 * 这三块是前面六版一直没碰的空白：
 *   - 群聊只有 v1.2 的 list / activate，建群、改成员、删群都得回 UI 手点
 *   - 角色卡里的 character_book（内嵌世界书）以前只能整卡导出再手工拆
 *   - 没见过有人能一句话回答「我的酒馆是哪里在变胖」
 */
import { getContext } from '../../../extensions.js';

const c = () => getContext();

/* ------------------------------ HTTP ------------------------------ */

async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { ...c().getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res;
}

async function getJson(url) {
    const res = await fetch(url, { headers: c().getRequestHeaders() });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.json();
}

/* ------------------------------ 群聊 ------------------------------ */

async function allGroups() {
    const res = await postJson('/api/groups/all', {});
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error('群聊列表返回结构异常');
    return list;
}

function findGroup(list, key) {
    if (key === undefined || key === null) throw new Error('需要 group（id 或名字）');
    return list.find(g => String(g.id) === String(key)) || list.find(g => g.name === key);
}

function groupBrief(g) {
    return {
        id: g.id,
        name: g.name,
        members: (g.members || []).length,
        disabled: (g.disabled_members || []).length,
        activation_strategy: g.activation_strategy,
        allow_self_responses: !!g.allow_self_responses,
        generation_mode: g.generation_mode,
        chats: (g.chats || []).length,
        chat_size_kb: g.chat_size ? Math.round(g.chat_size / 1024) : 0,
        last_chat: g.date_last_chat ? new Date(g.date_last_chat).toISOString() : null,
    };
}

/** 把群聊对象写回磁盘，并尽量让前端内存里那份同步（不同版本的酒馆可能没有 printGroups） */
async function saveGroup(group) {
    await postJson('/api/groups/edit', group);
    const arr = c().groups;
    if (Array.isArray(arr)) {
        const i = arr.findIndex(g => String(g.id) === String(group.id));
        if (i >= 0) arr[i] = group;
        else arr.push(group);
        try { c().printGroups?.(false); } catch { /* ignore */ }
    }
}

async function groupAll() {
    const list = await allGroups();
    return {
        count: list.length,
        groups: list.map(groupBrief),
        hint: 'members 是角色头像文件名数组（不是显示名）；建群与改成员用头像最稳。',
    };
}

async function groupInfo({ group } = {}) {
    const list = await allGroups();
    const g = findGroup(list, group);
    if (!g) throw new Error(`没有这个群聊：${group}`);
    const chars = c().characters || [];
    const memberDetail = (g.members || []).map(avatar => {
        const ch = chars.find(x => x.avatar === avatar);
        return {
            avatar,
            name: ch?.name ?? '(角色卡已删除)',
            disabled: (g.disabled_members || []).includes(avatar),
        };
    });
    return { ok: true, ...groupBrief(g), raw: { generation_mode_join_prefix: g.generation_mode_join_prefix, generation_mode_join_suffix: g.generation_mode_join_suffix, auto_mode_delay: g.auto_mode_delay }, members_detail: memberDetail };
}

async function groupCreate({
    name, members, activation_strategy = 0, allow_self_responses = false,
    generation_mode = 0, auto_mode_delay = 5,
} = {}) {
    if (!name) throw new Error('需要 name');
    if (!Array.isArray(members) || !members.length) throw new Error('需要 members（角色头像文件名数组，至少一个）');
    const chars = c().characters || [];
    const unknown = members.filter(m => !chars.some(x => x.avatar === m));
    if (unknown.length) throw new Error(`这些头像不在角色列表里：${unknown.join('、')}`);

    const res = await postJson('/api/groups/create', {
        name,
        members,
        allow_self_responses: !!allow_self_responses,
        activation_strategy: Number(activation_strategy),
        generation_mode: Number(generation_mode),
        auto_mode_delay: Number(auto_mode_delay),
    });
    const created = await res.json();
    const arr = c().groups;
    if (Array.isArray(arr)) arr.push(created);
    try { c().printGroups?.(false); } catch { /* ignore */ }
    return { ok: true, created: groupBrief(created), hint: '群聊已写入磁盘；进群聊列表即可看到（列表由 /api/groups/all 重新读）。' };
}

async function groupEdit({ group, name, members, add, remove, activation_strategy, allow_self_responses, generation_mode } = {}) {
    if (!group) throw new Error('需要 group（id 或名字）');
    const list = await allGroups();
    const g = findGroup(list, group);
    if (!g) throw new Error(`没有这个群聊：${group}`);
    const before = groupBrief(g);

    if (name !== undefined) g.name = String(name);
    if (Array.isArray(members)) g.members = members;
    if (add) {
        const chars = c().characters || [];
        const wanted = Array.isArray(add) ? add : [add];
        const unknown = wanted.filter(m => !chars.some(x => x.avatar === m));
        if (unknown.length) throw new Error(`这些头像不在角色列表里：${unknown.join('、')}`);
        g.members = [...new Set([...(g.members || []), ...wanted])];
    }
    if (remove) {
        const drop = Array.isArray(remove) ? remove : [remove];
        g.members = (g.members || []).filter(m => !drop.includes(m));
        g.disabled_members = (g.disabled_members || []).filter(m => !drop.includes(m));
    }
    if (activation_strategy !== undefined) g.activation_strategy = Number(activation_strategy);
    if (allow_self_responses !== undefined) g.allow_self_responses = !!allow_self_responses;
    if (generation_mode !== undefined) g.generation_mode = Number(generation_mode);

    await saveGroup(g);
    return { ok: true, before, after: groupBrief(g) };
}

async function groupDelete({ group } = {}) {
    const list = await allGroups();
    const g = findGroup(list, group);
    if (!g) throw new Error(`没有这个群聊：${group}`);
    await postJson('/api/groups/delete', { id: g.id });
    const arr = c().groups;
    if (Array.isArray(arr)) {
        const i = arr.findIndex(x => String(x.id) === String(g.id));
        if (i >= 0) arr.splice(i, 1);
        try { c().printGroups?.(false); } catch { /* ignore */ }
    }
    return { ok: true, deleted: groupBrief(g), note: '该群聊名下的聊天档（groupChats/*.jsonl）已被一并删除。' };
}

/* ------------------------------ 角色卡内嵌世界书 ------------------------------ */

function findChar(avatar) {
    const chars = c().characters || [];
    if (avatar) return chars.find(x => x.avatar === avatar) || chars.find(x => x.name === avatar);
    return chars[Number(c().characterId)];
}

async function charBook({ avatar, limit = 5 } = {}) {
    const ch = findChar(avatar);
    if (!ch) throw new Error('找不到角色卡：传 avatar 或用带名字的 avatar');
    const book = ch.data?.character_book;
    if (!book) {
        return { ok: true, avatar: ch.avatar, name: ch.name, has_book: false, hint: '这张卡没有内嵌世界书（data.character_book 为空）；它的世界书绑定应该看 data.extensions.world。' };
    }
    const entries = book.entries || [];
    return {
        ok: true,
        avatar: ch.avatar,
        name: ch.name,
        has_book: true,
        book_name: book.name || null,
        entries: entries.length,
        linked_world: ch.data?.extensions?.world || null,
        preview: entries.slice(0, Number(limit) || 5).map(e => ({
            id: e.id,
            comment: e.comment,
            keys: e.keys,
            enabled: e.enabled,
            insertion_order: e.insertion_order,
            chars: (e.content || '').length,
        })),
    };
}

async function charBookExtract({ avatar, world_name, overwrite = false } = {}) {
    const ch = findChar(avatar);
    if (!ch) throw new Error('找不到角色卡');
    const book = ch.data?.character_book;
    if (!book || !(book.entries || []).length) throw new Error('这张卡没有内嵌世界书，没东西可抽');

    const target = String(world_name || book.name || `${ch.name} - 内嵌书`).trim();
    const existing = (c().getWorldInfoNames?.() || []);
    if (existing.includes(target) && !overwrite) throw new Error(`世界书「${target}」已存在；确认覆盖就传 overwrite: true`);

    // 用酒馆自己的转换器把 character_book 转成世界书结构，别自己手搓字段（position/enabled 这些是反的）
    const wi = await import('/scripts/world-info.js');
    if (typeof wi.convertCharacterBook !== 'function') throw new Error('当前酒馆版本没有导出 convertCharacterBook');
    const converted = wi.convertCharacterBook(structuredClone(book));

    if (!existing.includes(target)) {
        // 走一条所有版本都稳的路：先落一个空本占位，再把真实内容写进去
        await c().saveWorldInfo(target, { entries: {} }, true);
    }
    await c().saveWorldInfo(target, converted, true);
    try { c().reloadWorldInfoEditor?.(target, true); } catch { /* ignore */ }

    return {
        ok: true,
        avatar: ch.avatar,
        world_name: target,
        entries: Object.keys(converted.entries || {}).length,
        overwritten: existing.includes(target),
        hint: '抽取只写了新世界书，原卡的内嵌书没动。想让它生效：lore.bind 给角色绑上，或用 lb.setGlobal 设成全局。',
    };
}

/* ------------------------------ 酒馆体检 ------------------------------ */

async function auditRun({ chatSample = 200 } = {}) {
    const x = c();
    const chars = x.characters || [];
    const books = x.getWorldInfoNames?.() || [];

    // 1) 角色卡 × 聊天档
    const charRows = [];
    let totalChatFiles = 0;
    let totalMessages = 0;
    for (const ch of chars) {
        let chats = [];
        try {
            const data = await getJson(`/api/characters/chats?avatar=${encodeURIComponent(ch.avatar)}&metadata=true`);
            chats = Array.isArray(data) ? data : [];
        } catch { /* 单卡失败不影响整体 */ }
        const msgs = chats.reduce((sum, c2) => sum + (Number(c2.mes_count ?? c2.message_count ?? 0) || 0), 0);
        totalChatFiles += chats.length;
        totalMessages += msgs;
        charRows.push({
            avatar: ch.avatar,
            name: ch.name,
            chats: chats.length,
            messages: msgs,
            world: ch.data?.extensions?.world || null,
            embedded_book: (ch.data?.character_book?.entries || []).length,
        });
    }

    // 2) 世界书条目量与“从没写 key 的条目”
    const bookRows = [];
    for (const name of books.slice(0, 20)) {
        let data = null;
        try { data = await x.loadWorldInfo(name); } catch { continue; }
        const entries = Object.values(data?.entries || {});
        bookRows.push({
            name,
            entries: entries.length,
            disabled: entries.filter(e => e.disable).length,
            constant: entries.filter(e => e.constant).length,
            keyless: entries.filter(e => !e.constant && !(e.key || []).length).length,
            duplicated: entries.filter(e => (e.key || []).length && (e.keysecondary || []).length).length,
        });
    }

    // 3) 群聊
    let groups = [];
    try { groups = await allGroups(); } catch { /* ignore */ }

    // 4) 最近聊天档
    let recent = [];
    try {
        const res = await postJson('/api/chats/recent', { pinned: [], max: Math.min(Number(chatSample) || 200, 500), metadata: true });
        recent = await res.json();
    } catch { /* ignore */ }
    const recentRows = (Array.isArray(recent) ? recent : []).map(r => ({
        file: r.file_name,
        avatar: r.avatar,
        messages: r.chat_items ?? null,
    }));
    const biggest = recentRows.slice().sort((a, b) => (b.messages || 0) - (a.messages || 0)).slice(0, 5);

    // 5) 正则
    const regexCount = Array.isArray(x.extension_settings?.regex) ? x.extension_settings.regex.length : 0;

    const noChat = charRows.filter(r => r.chats === 0).map(r => r.name);
    const hint = [];
    if (noChat.length) hint.push(`${noChat.length} 张卡没有任何聊天记录（想清磁盘可从它们下手）：${noChat.slice(0, 6).join('、')}`);
    const keyless = bookRows.filter(b => b.keyless > 0);
    if (keyless.length) hint.push(`${keyless.length} 本世界书里有非 constant 条目没写 key（永远不会被触发）：${keyless.map(b => `${b.name}×${b.keyless}`).join('、')}`);
    if (biggest[0]?.messages >= 200) hint.push(`最大的一档聊天有 ${biggest[0].messages} 楼（${biggest[0].file}），上下文和加载都会变慢`);

    return {
        ok: true,
        summary: {
            characters: chars.length,
            characters_without_chat: noChat.length,
            worldbooks: books.length,
            worldbook_entries: bookRows.reduce((s, b) => s + b.entries, 0),
            groups: groups.length,
            chat_files: totalChatFiles,
            messages_estimate: totalMessages,
            regex_scripts: regexCount,
        },
        characters: charRows,
        worldbooks: bookRows,
        groups: groups.map(groupBrief),
        largest_recent_chats: biggest,
        advice: hint,
    };
}

/* ------------------------------ 第三方扩展维护 ------------------------------ */

async function extMaintain({ action = 'update', id } = {}) {
    const api = globalThis.TavernHelper;
    if (!api) throw new Error('需要「酒馆助手」在线才能更新/重装第三方扩展');
    if (!id) throw new Error('需要 id（扩展目录名，如 JS-Slash-Runner）');
    const fn = action === 'reinstall' ? api.reinstallExtension : (action === 'update' ? api.updateExtension : null);
    if (!fn) throw new Error('action 只能是 update / reinstall');

    // 先探一下这扩展是不是 git 装的：不是的话 update 必然 500，reinstall 更危险（先删再按 URL 装，URL 空就直接没了）
    let info = null;
    try { info = await api.getExtensionInstallationInfo?.(id); } catch { /* ignore */ }
    const remote = typeof info?.remote_url === 'string' ? info.remote_url : '';
    const isGit = /^https?:\/\//.test(remote);

    if (!isGit) {
        return {
            ok: false, action, id, reason: 'not_a_git_repo',
            hint: action === 'reinstall'
                ? '已拒绝：这不是 git 安装的扩展（没有 remote_url），reinstall 会先删除目录再按 URL 重装，URL 为空等于删完装不回来。请手动覆盖文件，或删掉后用「安装扩展」填仓库地址重装。'
                : '这不是 git 安装的扩展（没有 remote_url），服务端 update 只会执行 git pull，必然 500。请手动覆盖文件，或删掉后用仓库地址重装。',
            info,
        };
    }

    const res = await fn.call(api, id);
    let message = null;
    try { message = await res.clone().text(); } catch { /* ignore */ }
    return {
        ok: res.status === 200,
        action, id,
        http: res.status,
        message: message && message.length < 200 ? message : null,
        version: info?.current_commit_hash ? String(info.current_commit_hash).slice(0, 7) : null,
        branch: info?.current_branch_name || null,
        remote,
        hint: '更新完要刷新页面才会重新加载扩展代码。',
    };
}

/* ------------------------------ 导出 ------------------------------ */

export const TOOLS = [
    {
        name: 'group.all', kind: 'read',
        desc: '列全部群聊：id、名字、成员数、禁用成员数、激活策略、聊天档数与体积、最后聊天时间。比 group.list 多给体积和时间，用来判断哪个群该清。',
        params: {},
        run: () => groupAll(),
    },
    {
        name: 'group.info', kind: 'read',
        desc: '看一个群聊的成员明细（头像、角色名、是否被禁用）与生成设置。传 id 或群名。',
        params: { group: '群聊 id 或名字' },
        run: a => groupInfo(a),
    },
    {
        name: 'group.create', kind: 'write',
        desc: '新建群聊。members 传角色头像文件名数组（不是显示名），激活策略 0=自然顺序 1=列表顺序 2=随机。',
        params: { name: '群名', members: '头像数组', activation_strategy: '0|1|2，默认 0', allow_self_responses: '是否允许自己接话', generation_mode: '默认 0', auto_mode_delay: '自动模式间隔秒，默认 5' },
        run: a => groupCreate(a),
    },
    {
        name: 'group.edit', kind: 'write',
        desc: '改群聊：改名、整体替换成员、加成员（add）、踢成员（remove）、改激活策略 / 是否允许自答 / 生成模式。只传要改的。',
        params: { group: 'id 或名字', name: '新群名', members: '整体替换的头像数组', add: '要加的头像（单个或数组）', remove: '要踢的头像', activation_strategy: '0|1|2', allow_self_responses: '布尔', generation_mode: '数字' },
        run: a => groupEdit(a),
    },
    {
        name: 'group.delete', kind: 'dangerous',
        desc: '删群聊，连它名下的 groupChats/*.jsonl 一起删。不可恢复。',
        params: { group: 'id 或名字' },
        run: a => groupDelete(a),
    },
    {
        name: 'char.book', kind: 'read',
        desc: '读角色卡内嵌世界书（data.character_book）：条目数、书名叫什么、前几条的 comment/keys/是否启用，以及这张卡当前绑的独立世界书。',
        params: { avatar: '头像文件名（不传=当前角色）', limit: '预览条数，默认 5' },
        run: a => charBook(a),
    },
    {
        name: 'char.bookExtract', kind: 'write',
        desc: '把角色卡内嵌世界书抽成一个独立世界书（用酒馆自己的 convertCharacterBook 转字段，不改原卡）。原名存在时默认拒绝，overwrite 才覆盖。',
        params: { avatar: '头像（不传=当前角色）', world_name: '新世界书名，默认 book.name 或「角色名 - 内嵌书」', overwrite: '同名时是否覆盖' },
        run: a => charBookExtract(a),
    },
    {
        name: 'audit.run', kind: 'read',
        desc: '一次导出酒馆体检报告：角色卡×聊天档数量与楼层、世界书条目量（含没写 key 的死条目）、群聊体积、最近聊天里最大的一档、正则条数，并给出可执行的清理建议。想回答「我的酒馆哪里在变胖」用这个。',
        params: { chatSample: '最多采样多少档最近聊天，默认 200' },
        run: a => auditRun(a),
    },
    {
        name: 'ext.maintain', kind: 'write',
        desc: '维护第三方扩展（需酒馆助手在线）：update 拉最新版、reinstall 原地重装。用于升级酒馆助手自己这类扩展。',
        params: { action: 'update|reinstall', id: '扩展目录名，如 JS-Slash-Runner' },
        run: a => extMaintain(a),
    },
];
