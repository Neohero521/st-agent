import { c, postJson } from './v17-lib.js';

/* ------------------------------ 群聊 ------------------------------ */

export async function allGroups() {
    const res = await postJson('/api/groups/all', {});
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error('群聊列表返回结构异常');
    return list;
}

export function findGroup(list, key) {
    if (key === undefined || key === null) throw new Error('需要 group（id 或名字）');
    return list.find(g => String(g.id) === String(key)) || list.find(g => g.name === key);
}

export function groupBrief(g) {
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
export async function saveGroup(group) {
    await postJson('/api/groups/edit', group);
    const arr = c().groups;
    if (Array.isArray(arr)) {
        const i = arr.findIndex(g => String(g.id) === String(group.id));
        if (i >= 0) arr[i] = group;
        else arr.push(group);
        try { c().printGroups?.(false); } catch { /* ignore */ }
    }
}

export async function groupAll() {
    const list = await allGroups();
    return {
        count: list.length,
        groups: list.map(groupBrief),
        hint: 'members 是角色头像文件名数组（不是显示名）；建群与改成员用头像最稳。',
    };
}

export async function groupInfo({ group } = {}) {
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

export async function groupCreate({
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

export async function groupEdit({ group, name, members, add, remove, activation_strategy, allow_self_responses, generation_mode } = {}) {
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

export async function groupDelete({ group } = {}) {
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
