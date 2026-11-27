import { getContext } from '../../../extensions.js';
import { api, clone, readPath, findCharacter, OPS_LIMIT } from './v20-lib.js';
import { CATALOG } from './v20-catalog-a.js';
import './v20-catalog-b.js';

const c = () => getContext();

/* ------------------------------ 预演 ------------------------------ */

export function normalizeOps(input) {
    let ops = input;
    if (typeof ops === 'string') {
        try { ops = JSON.parse(ops); } catch { throw new Error('ops 不是合法 JSON'); }
    }
    if (!Array.isArray(ops)) throw new Error('ops 必须是数组：元素形如 {"tool":"world.upsertEntry","args":{...}}');
    return ops;
}

export async function planOps(ops) {
    const items = [];
    const errors = [];
    const truncated = Math.max(0, ops.length - OPS_LIMIT);
    const usable = ops.slice(0, OPS_LIMIT);

    for (let i = 0; i < usable.length; i++) {
        const op = usable[i] || {};
        const tool = String(op.tool || op.name || '');
        let args = op.args ?? op.arguments ?? {};
        if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { args = {}; }
        }
        if (!args || typeof args !== 'object') args = {};
        const spec = CATALOG.get(tool);
        if (!spec) {
            const message = `不允许批处理的工具：${tool || '(空)'}（可用 ops.catalog 查看清单）`;
            errors.push({ i, tool, message });
            items.push({ i, tool, target: '?', change: 'blocked', level: 3, undo: 'none', warnings: [message] });
            continue;
        }
        try {
            const r = await spec.predict(args);
            const item = {
                i,
                tool,
                target: spec.target(args),
                change: r.error ? 'error' : (r.change || 'unknown'),
                level: spec.level,
                undo: spec.undo,
                note: r.note || '',
                warnings: r.warnings || [],
                why: op.why || '',
            };
            if (r.error) errors.push({ i, tool, message: r.error });
            items.push(item);
        } catch (error) {
            errors.push({ i, tool, message: error.message });
            items.push({ i, tool, target: '?', change: 'error', level: spec.level, undo: spec.undo, warnings: [error.message] });
        }
    }

    const counts = items.reduce((acc, it) => {
        acc[it.change] = (acc[it.change] || 0) + 1;
        return acc;
    }, {});
    const highest = items.reduce((n, it) => Math.max(n, it.level), 0);
    return { items, errors, truncated, counts, highest };
}

export function newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export const PLANS = (window.__staOpsPlans = window.__staOpsPlans || new Map());
export const JOURNALS = (window.__staOpsJournals = window.__staOpsJournals || []);

export function opsHash(ops) {
    return ops.map(op => `${op.tool || op.name}:${JSON.stringify(op.args ?? op.arguments ?? {})}`).join('|');
}

/* ------------------------------ 快照 ------------------------------ */

export async function takeSnapshots(ops) {
    const snapshots = [];
    const seen = new Set();

    for (const op of ops) {
        const tool = String(op.tool || op.name || '');
        const spec = CATALOG.get(tool);
        if (!spec || spec.undo === 'none') continue;
        let args = op.args ?? op.arguments ?? {};

        if (spec.undo === 'world') {
            const name = String(args.name || '');
            if (!name || seen.has(`world:${name}`)) continue;
            seen.add(`world:${name}`);
            const data = await c().loadWorldInfo(name).catch(() => null);
            snapshots.push({ kind: 'world', name, existed: !!data, data: clone(data) });
        }

        if (spec.undo === 'char') {
            const ch = findCharacter(args.name);
            if (!ch || seen.has(`char:${ch.avatar}`)) continue;
            seen.add(`char:${ch.avatar}`);
            snapshots.push({ kind: 'char', avatar: ch.avatar, name: ch.name, fields: clone(ch) });
        }

        if (spec.undo === 'setting') {
            const path = String(args.path || '');
            if (!path || seen.has(`setting:${path}`)) continue;
            seen.add(`setting:${path}`);
            const all = await api('/api/settings/get', {}).catch(() => null);
            snapshots.push({ kind: 'setting', path, existed: all ? readPath(all, path) !== undefined : false, old: all ? clone(readPath(all, path)) : undefined });
        }
    }
    return snapshots;
}
