import { getContext } from '../../../extensions.js';

/**
 * 酒馆内部工具集（纯前端，走 SillyTavern 自己的 /api/*，不需要服务端插件）
 * BRIDGE_TOOLS 是可选的额外能力：只有装了 st-agent-bridge 服务端插件才有。
 */

export const c = () => getContext();

/* ------------------------------ 请求封装 ------------------------------ */

export async function api(path, body = {}) {
    const response = await fetch(path, {
        method: 'POST',
        headers: c().getRequestHeaders(),
        body: JSON.stringify(body),
    });
    const type = response.headers.get('content-type') || '';
    const data = type.includes('json') ? await response.json().catch(() => null) : await response.text();
    if (!response.ok) {
        const detail = typeof data === 'string' ? data : JSON.stringify(data);
        throw new Error(`HTTP ${response.status} ${path}：${String(detail).slice(0, 300)}`);
    }
    return data;
}

export async function apiGet(path) {
    const response = await fetch(path, { method: 'GET', headers: c().getRequestHeaders() });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
    return response.json();
}

export async function apiForm(path, fields) {
    const headers = c().getRequestHeaders();
    delete headers['Content-Type'];
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;
        if (typeof value === 'object') {
            if (value instanceof Blob) form.append(key, value, value.name || 'file');
            else form.append(key, JSON.stringify(value));
        } else {
            form.append(key, String(value));
        }
    }
    const response = await fetch(path, { method: 'POST', headers, body: form });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${path}：${text.slice(0, 300)}`);
    }
    return response;
}

export async function bridge(path, body = {}) {
    const response = await fetch(`/api/plugins/st-agent-bridge${path}`, {
        method: 'POST',
        headers: c().getRequestHeaders(),
        body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
    if (!json.ok) throw new Error(json.error || '桥接调用失败');
    return json.data;
}

/* ------------------------------ 小工具 ------------------------------ */

export function pickCharacter(name) {
    const list = c().characters || [];
    return list.find(x => x.avatar === name) || list.find(x => x.name === name) || null;
}

export function characterSummary(ch) {
    return {
        name: ch.name,
        avatar: ch.avatar,
        tags: ch.tags || [],
        creator: ch.creator || '',
        description: String(ch.description || '').slice(0, 150),
    };
}

export function getSettingByPath(obj, path) {
    if (!path) return obj;
    return path.split('.').filter(Boolean).reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

export async function refreshCharacters() {
    const x = c();
    try {
        const list = await api('/api/characters/all', {});
        if (Array.isArray(list)) {
            x.characters.splice(0, x.characters.length, ...list);
        }
    } catch { /* ignore */ }
}
