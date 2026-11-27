import { c, api, apiGet, apiForm, bridge, pickCharacter, characterSummary, getSettingByPath, refreshCharacters } from './tools-lib.js';

/**
 * 正则 placement 必须是数字：ST 正则编辑器保存时把勾选框 parseInt 成数字数组，
 * 引擎判定是 script.placement.includes(数字)。枚举见 public/scripts/extensions/regex/engine.js:
 * MD_DISPLAY=0(已废弃)、USER_INPUT=1、AI_OUTPUT=2、SLASH_COMMAND=3、WORLD_INFO=5、REASONING=6。
 * 这里允许传名字或数字，一律归一成数字；未知名字按 AI_OUTPUT 处理并保留原名，避免静默失效。
 */
const PLACEMENT_NUM = { MD_DISPLAY: 0, USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6, SENDAS: 2 };
const toPlacement = v => {
    const arr = Array.isArray(v) ? v : (v === undefined ? [2] : [v]);
    return arr.map(x => {
        if (typeof x === 'number' && Number.isFinite(x)) return x;
        const k = String(x).trim().toUpperCase();
        return Object.prototype.hasOwnProperty.call(PLACEMENT_NUM, k) ? PLACEMENT_NUM[k] : 2;
    });
};
export { toPlacement };

export const ST_TOOLS_C = [
    {
        name: 'setting.get',
        kind: 'read',
        desc: '读取酒馆设置。可用 path 取单个字段（如 "power_user.context.max_context"）；不传返回精简概览。',
        params: { path: 'string 点路径，可选' },
        run: async a => {
            const all = await api('/api/settings/get', {});
            if (a.path) return getSettingByPath(all, a.path);
            const { power_user, ...rest } = all;
            return {
                keys: Object.keys(all),
                power_user: {
                    context: power_user?.context,
                    instruct: power_user?.instruct,
                    persona_name: power_user?.persona_name,
                },
                extensionSettingsKeys: Object.keys(rest.extension_settings || {}),
                world_names: rest.world_names,
            };
        },
    },
    {
        name: 'setting.set',
        kind: 'dangerous',
        desc: '按点路径修改酒馆设置并保存（会整体重写 settings.json，需确认）。',
        params: { path: 'string 点路径', value: 'any 新值' },
        run: async a => {
            const all = await api('/api/settings/get', {});
            const parts = String(a.path).split('.').filter(Boolean);
            let cursor = all;
            for (const key of parts.slice(0, -1)) {
                cursor[key] = cursor[key] ?? {};
                cursor = cursor[key];
            }
            cursor[parts[parts.length - 1]] = a.value;
            await api('/api/settings/save', all);
            return { ok: true, path: a.path };
        },
    },
    {
        name: 'preset.save',
        kind: 'write',
        desc: '保存/覆盖一个预设（apiId: openai / textgeneration / instruct / context / reasoning）。',
        params: { name: 'string 预设名', apiId: 'string 类型', preset: 'object 预设内容' },
        run: async a => {
            await api('/api/presets/save', { name: a.name, apiId: a.apiId || 'openai', preset: a.preset });
            return { ok: true, name: a.name };
        },
    },
    {
        name: 'preset.delete',
        kind: 'dangerous',
        desc: '删除一个预设。需确认。',
        params: { name: 'string 预设名', apiId: 'string' },
        run: async a => {
            await api('/api/presets/delete', { name: a.name, apiId: a.apiId || 'openai' });
            return { ok: true, deleted: a.name };
        },
    },
    {
        name: 'extension.list',
        kind: 'read',
        desc: '列出已安装扩展（系统 / 内置 / 用户 / 第三方）。',
        params: {},
        run: async () => apiGet('/api/extensions/discover'),
    },
    {
        name: 'extension.install',
        kind: 'exec',
        desc: '从 Git URL 安装扩展（需要主机已装 git）。',
        params: { url: 'string 仓库地址' },
        run: async a => {
            await api('/api/extensions/install', { url: a.url });
            return { ok: true, url: a.url, note: '刷新页面后生效' };
        },
    },
    {
        name: 'extension.delete',
        kind: 'dangerous',
        desc: '删除一个扩展目录（需确认）。',
        params: { name: 'string 扩展 id（如 third-party/xxx）' },
        run: async a => {
            await api('/api/extensions/delete', { extensionName: a.name });
            return { ok: true, deleted: a.name };
        },
    },

    /* ---------------- 正则 / 脚本 ---------------- */
    {
        name: 'regex.list',
        kind: 'read',
        desc: '列出全部正则脚本。',
        params: {},
        run: async () => (c().extensionSettings?.regex || []).map(r => ({
            scriptName: r.scriptName,
            findRegex: r.findRegex,
            replaceString: r.replaceString,
            placement: r.placement,
            disabled: r.disabled,
        })),
    },
    {
        name: 'regex.upsert',
        kind: 'write',
        desc: '按脚本名新增或更新酒馆原生正则脚本。placement 必须落成数字（ST 的 extensionSettings.regex 存的是数字数组：USER_INPUT=1、AI_OUTPUT=2、SLASH_COMMAND=3、WORLD_INFO=5、REASONING=6，正则编辑器保存时是 parseInt 过的；写字符串会被 script.placement.includes(数字) 判成不匹配，正则表面存在却完全不生效）。同时支持 markdownOnly（只在显示层替换，如状态栏美化）、promptOnly（只在发给模型前替换，如隐藏标记）两个开关。',
        params: {
            scriptName: 'string 脚本名',
            findRegex: 'string 查找正则，形如 /pattern/flags',
            replaceString: 'string 替换内容（支持 $1 与 {{match}}）',
            placement: 'array 字符串名或数字，如 ["AI_OUTPUT"] 或 [2]',
            disabled: 'boolean 可选',
            markdownOnly: 'boolean 可选，只在显示层生效（不改变发给模型的正文）',
            promptOnly: 'boolean 可选，只在发送给模型前生效',
            runOnEdit: 'boolean 可选，编辑消息时也执行',
            substituteRegex: 'number 可选，findRegex 里宏替换方式：0=不替换 1=替换为原文 2=替换为转义文本',
        },
        run: async a => {
            const x = c();
            x.extensionSettings = x.extensionSettings || {};
            const list = x.extensionSettings.regex || (x.extensionSettings.regex = []);
            let item = list.find(r => r.scriptName === a.scriptName);
            if (!item) {
                item = { id: `st-agent-${Date.now()}`, scriptName: a.scriptName, findRegex: '', replaceString: '', placement: [2], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, substituteRegex: 0 };
                list.push(item);
            }
            Object.assign(item, {
                findRegex: a.findRegex ?? item.findRegex,
                replaceString: a.replaceString ?? item.replaceString,
                placement: a.placement === undefined ? item.placement : toPlacement(a.placement),
                disabled: a.disabled ?? item.disabled,
            });
            if (a.markdownOnly !== undefined) item.markdownOnly = !!a.markdownOnly;
            if (a.promptOnly !== undefined) item.promptOnly = !!a.promptOnly;
            if (a.runOnEdit !== undefined) item.runOnEdit = !!a.runOnEdit;
            if (a.substituteRegex !== undefined) item.substituteRegex = Number(a.substituteRegex);
            x.saveSettingsDebounced?.();
            return {
                ok: true,
                scriptName: a.scriptName,
                placement: item.placement,
                flags: { markdownOnly: !!item.markdownOnly, promptOnly: !!item.promptOnly, runOnEdit: !!item.runOnEdit },
            };
        },
    },
    {
        name: 'st.command',
        kind: 'exec',
        desc: '执行 SillyTavern STscript（/send、/trigger、/world、/persona、/go、/sys 等），等于拿到酒馆全部指令。',
        params: { command: 'string 以 / 开头的脚本' },
        run: async a => {
            const result = await c().executeSlashCommandsWithOptions(a.command, { showOutput: false });
            const text = typeof result === 'string' ? result : JSON.stringify(result);
            return { ok: true, result: String(text).slice(0, 8000) };
        },
    },
    {
        name: 'ui.reload',
        kind: 'write',
        desc: '刷新酒馆前端（让直接改过的文件 / 扩展生效）。',
        params: {},
        run: async () => {
            setTimeout(() => location.reload(), 800);
            return { ok: true, note: '页面将在 1 秒后刷新' };
        },
    },
];
