import { getContext } from '../../../extensions.js';
import { api, readPath, short } from './v20-lib.js';
import { CATALOG, reg } from './v20-catalog-a.js';

export { CATALOG };

const c = () => getContext();

/* ---- 设置 / 正则 / 预设 / 注入 / 变量 ---- */

reg('setting.set', 3, 'setting',
    a => `设置 ${a.path}`,
    async a => {
        if (!a.path) return { error: '缺少 path' };
        const all = await api('/api/settings/get', {});
        const old = readPath(all, a.path);
        if (JSON.stringify(old) === JSON.stringify(a.value)) return { change: 'noop', note: '与当前值一致' };
        return { change: 'update', note: `当前值 ${short(old, 60)} → ${short(a.value, 60)}`, warnings: ['会整体重写 settings.json'] };
    });

reg('regex.upsert', 2, 'none',
    a => `正则 ${a.scriptName || '?'}`,
    async a => {
        if (!a.scriptName) return { error: '缺少 scriptName' };
        if (a.findRegex === undefined) return { error: '缺少 findRegex' };
        const list = c().extensionSettings?.regex ?? [];
        const hit = list.find(r => r.scriptName === a.scriptName);
        if (!hit) return { change: 'create', note: `当前共 ${list.length} 条正则` };
        const changed = ['findRegex', 'replaceString', 'placement', 'disabled'].filter(k => a[k] !== undefined && JSON.stringify(hit[k]) !== JSON.stringify(a[k]));
        return changed.length ? { change: 'update', note: `字段变化：${changed.join(', ')}` } : { change: 'noop' };
    });

reg('regex.setEnabled', 2, 'none',
    a => `正则 ${a.scriptName || '?'} → ${a.enabled ? '启用' : '禁用'}`,
    async a => {
        const list = c().extensionSettings?.regex ?? [];
        return list.find(r => r.scriptName === a.scriptName) ? { change: 'update' } : { error: `未找到正则：${a.scriptName}` };
    });

reg('script.set', 2, 'none',
    a => `脚本 ${a.name || '?'}`,
    async a => {
        if (!a.name) return { error: '缺少 name' };
        if (a.code === undefined || a.code === null) return { error: '缺少 code' };
        const tree = window.TavernHelper?.getScriptTrees?.() ?? [];
        const hit = tree.find(t => t.name === a.name);
        return hit ? { change: 'update' } : { change: 'create' };
    });

reg('preset.save', 2, 'none',
    a => `预设 ${a.name || '?'}（${a.apiId || 'openai'}）`,
    async a => (a.name && a.preset ? { change: 'update', warnings: ['同名预设会被覆盖'] } : { error: '需要 name 与 preset' }));

reg('preset.delete', 3, 'none',
    a => `预设 ${a.name || '?'}`,
    async a => (a.name ? { change: 'delete', warnings: ['删除预设'] } : { error: '缺少 name' }));

reg('inject.set', 2, 'none',
    a => `注入 ${a.name || a.id || '?'}`,
    async a => (a.content || a.value ? { change: 'update' } : { error: '缺少 content' }));

reg('var.set', 2, 'none',
    a => `变量 ${a.path || a.key || '?'}`,
    async a => (a.path || a.key ? { change: 'update' } : { error: '缺少 path / key' }));
