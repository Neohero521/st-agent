import { getContext } from '../../../extensions.js';

export const c = () => getContext();

/* ------------------------------ HTTP ------------------------------ */

export async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { ...c().getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res;
}

export async function getJson(url) {
    const res = await fetch(url, { headers: c().getRequestHeaders() });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.json();
}
