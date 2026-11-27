import { getContext } from '../../../extensions.js';

const c = () => getContext();

export const OPS_LIMIT = 40;

export const LEVEL_LABEL = { 1: 'read', 2: 'write', 3: 'high' };

/* ------------------------------ HTTP ------------------------------ */

export async function api(path, body = {}) {
    const response = await fetch(path, {
        method: 'POST',
        headers: c().getRequestHeaders(),
        body: JSON.stringify(body),
    });
    const type = response.headers.get('content-type') || '';
    const data = type.includes('json') ? await response.json().catch(() => null) : await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
    return data;
}

export async function apiGet(path) {
    const response = await fetch(path, { method: 'GET', headers: c().getRequestHeaders() });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
    return response.json();
}

/* ------------------------------ 小工具 ------------------------------ */

export function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

export function readPath(obj, path) {
    return String(path).split('.').filter(Boolean)
        .reduce((cur, key) => (cur && typeof cur === 'object' ? cur[key] : undefined), obj);
}

export function findCharacter(nameOrAvatar) {
    const list = c().characters ?? [];
    if (!nameOrAvatar) return list[c().characterId] || null;
    const key = String(nameOrAvatar);
    return list.find(ch => ch.avatar === key || ch.avatar === `${key}.png` || ch.name === key) || null;
}

export function short(value, max = 40) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) return '';
    return text.length > max ? text.slice(0, max) + '…' : text;
}
