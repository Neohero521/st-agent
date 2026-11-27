import { getContext } from '../../../extensions.js';

export const c = () => getContext();

/* ------------------------------ HTTP ------------------------------ */

export async function call(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { ...c().getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    if (!res.ok) {
        const err = new Error(`${url} → HTTP ${res.status}${text && text.length < 200 ? ' ' + text : ''}`);
        err.status = res.status;
        throw err;
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
}
