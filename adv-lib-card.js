import { getContext } from '../../../extensions.js';
import { fetchWithTimeout } from './adv-lib-net.js';

/**
 * 角色卡「写回酒馆」的统一通道（v1.30，照抄写卡器 v329.59 的写入链路）
 *
 * 写卡器（我的写卡器-v329.59.js）从不直接调 /api/characters/merge-attributes 写 extensions，
 * 它走的是三件事：
 *   1) 用 updateCharacterWith(name, fn) 在前端改 charData（酒馆助手提供的 API，酒馆自己负责落盘）；
 *   2) 改的是 **整块 extensions**（regex_scripts / tavern_helper 一起），不是深合并某一个小 key；
 *   3) 写完强制同步内存里的角色对象与面板，解决「写入成功但酒馆里看不到」。
 *
 * 我们之前只做了第 3 步的一半，写入却是 `merge-attributes` + 手写体（连 CSRF header 都没带），
 * 手机上直接 HTTP 403；即便侥幸 200，深合并也常把 tavern_helper.scripts 吞掉（用户看到的"假成功"）。
 *
 * 这里按「最稳 → 次稳 → 兜底」三级来：
 *   A. POST /api/characters/edit-attribute  —— ST 原生端点，body 只带 avatar_url / ch_name / field / value，
 *      服务端 read → 改 → write，不经过 V2 深合并校验，权限面最小；一次写整块 extensions。
 *   B. POST /api/characters/merge-attributes —— 上一版用的通道，保留兜底；必须带 getRequestHeaders()（CSRF）。
 *   C. TavernHelper.updateCharacterWith      —— 写卡器原路径，装了酒馆助手时才可用。
 *
 * 三者都由同一个 mutate(extensions) 产出结果，成功后再统一同步内存 + json_data + 面板。
 */

const c = () => getContext();

function clone(v) {
    try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v ?? {})); }
}

function findCard(avatar) {
    const list = c()?.characters || [];
    if (avatar) return list.find(x => x && (x.avatar === avatar || x.name === avatar)) || null;
    return list[c()?.characterId] || null;
}

/** 酒馆助手的 API 宿主（装了 JS-Slash-Runner 才有） */
function thHost() {
    const cands = [];
    try { if (globalThis.TavernHelper) cands.push(globalThis.TavernHelper); } catch { /* ignore */ }
    try { if (window?.TavernHelper) cands.push(window.TavernHelper); } catch { /* ignore */ }
    try { if (window?.parent && window.parent !== window && window.parent.TavernHelper) cands.push(window.parent.TavernHelper); } catch { /* ignore */ }
    for (const h of cands) if (h && typeof h.updateCharacterWith === 'function') return h;
    return null;
}

export function cardWriteChannels() {
    return {
        edit_attribute: true,
        merge_attributes: true,
        tavern_helper: !!thHost(),
    };
}

/**
 * 把整块 extensions 写回某张卡。
 * @param avatar 头像文件名（也可传角色名）
 * @param mutate (cur:object) => object|Promise<object>  收到当前 extensions 的深拷贝，返回要写入的新块
 */
export async function writeCardExtensions(avatar, mutate, opts = {}) {
    const card = findCard(avatar);
    if (!card) throw new Error(`找不到角色卡：${avatar || '(当前)'}（先打开一张卡）`);

    const cur = clone(card?.data?.extensions || card?.extensions || {});
    const next = (await mutate(cur)) || cur;
    const headers = Object.assign({ 'Content-Type': 'application/json' }, c().getRequestHeaders?.() || {});
    const tried = [];

    // ── A. edit-attribute（原生端点，一次替换整块 extensions） ──
    let ok = false;
    try {
        const res = await fetchWithTimeout('/api/characters/edit-attribute', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                avatar_url: card.avatar,
                ch_name: card.name || String(card.avatar || '').replace(/\.png$/i, ''),
                field: 'extensions',
                value: next,
            }),
        });
        tried.push(`edit-attribute:${res.status}`);
        ok = res.ok;
        if (!res.ok && res.status === 400) {
            // 400 常见于「卡里没有 extensions 字段」——交给 merge 通道建字段
            console.warn('[st-agent] edit-attribute 400，转 merge-attributes');
        }
    } catch (e) {
        tried.push(`edit-attribute:${e && e.message}`);
    }

    // ── B. merge-attributes（深合并，兜底；必须带 CSRF header） ──
    if (!ok) {
        try {
            const res = await fetchWithTimeout('/api/characters/merge-attributes', {
                method: 'POST',
                headers,
                body: JSON.stringify({ avatar: card.avatar, data: { extensions: next }, extensions: next }),
            });
            tried.push(`merge-attributes:${res.status}`);
            ok = res.ok;
            if (!res.ok) {
                let detail = '';
                try { const j = await res.json(); detail = j?.error || j?.message || ''; } catch { /* ignore */ }
                if (detail) tried.push(`detail:${String(detail).slice(0, 120)}`);
            }
        } catch (e) {
            tried.push(`merge-attributes:${e && e.message}`);
        }
    }

    // ── C. 酒馆助手 updateCharacterWith（写卡器原路径） ──
    if (!ok) {
        const th = thHost();
        if (th) {
            try {
                await th.updateCharacterWith(card.name, cd => {
                    const merged = clone(cd.extensions || {});
                    Object.assign(merged, next);
                    cd.extensions = merged;
                    if (cd.data && typeof cd.data === 'object') cd.data.extensions = merged;
                    return cd;
                });
                tried.push('tavern_helper:ok');
                ok = true;
            } catch (e) {
                tried.push(`tavern_helper:${e && e.message}`);
            }
        } else {
            tried.push('tavern_helper:absent');
        }
    }

    if (!ok) throw new Error(`写入角色卡失败（全部通道都被拒）：${tried.join(' | ')}`);

    // ── 收尾：内存 + 原始 JSON + 面板（写卡器第 3 步） ──
    card.data = card.data || {};
    card.data.extensions = next;
    card.extensions = next;
    if (card.json_data) {
        try {
            const raw = JSON.parse(card.json_data);
            raw.data = raw.data || {};
            raw.data.extensions = next;
            card.json_data = JSON.stringify(raw);
        } catch { /* 卡不是合法 JSON 就跳过 */ }
    }
    try { c().saveSettingsDebounced?.(); } catch { /* ignore */ }

    // 服务端回读一次：以磁盘为准刷新内存，避免「写成功但当前会话还看旧卡」
    let reread = false;
    if (opts.reread !== false && typeof c().getOneCharacter === 'function') {
        try { await c().getOneCharacter(card.avatar); reread = true; } catch { /* 失败就用本地同步结果 */ }
    }

    return { ok: true, avatar: card.avatar, name: card.name, channel: tried.filter(x => /ok$|:20\d$/.test(x)).pop() || tried.join('|'), tried, reread };
}

/** 读某张卡当前 extensions（深拷贝，改坏不影响内存） */
export function readCardExtensions(avatar) {
    const card = findCard(avatar);
    return clone(card?.data?.extensions || card?.extensions || {});
}

/** 该卡是否真的能拿到（给工具做前置校验，错误信息统一） */
export function ensureCard(avatar) {
    const card = findCard(avatar);
    if (!card) throw new Error(`找不到角色卡：${avatar || '(当前)'}（先打开一张卡）`);
    return card;
}
