import { c, getJson, postJson } from './v17-lib.js';
import { allGroups, groupBrief } from './v17-group.js';

/* ------------------------------ 酒馆体检 ------------------------------ */

export async function auditRun({ chatSample = 200 } = {}) {
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

export async function extMaintain({ action = 'update', id } = {}) {
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
