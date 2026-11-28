import { c, api, apiGet, apiForm, bridge, pickCharacter, characterSummary, getSettingByPath, refreshCharacters } from './tools-lib.js';
import { INSTALL_TIMEOUT_MS } from './adv-lib-net.js';
import { charBy, scopedScripts, upsertScoped, allRegexes, scopedAllowed } from './adv-lib-regex.js';

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
        kind: 'dangerous',
        desc: '从 Git URL 安装扩展（后端执行 git clone，**很容易挂死**）。默认不执行：必须显式传 confirm:true，而且只有在用户明确说“装吧”时才传。没探测到某个扩展不等于要自动装——先把情况告诉用户，别自作主张。**MVU 更是完全不用装扩展**：本体是卡内一条 import bundle.js 的脚本（mvu.runtime 写），这里不该出现 MagVarUpdate。中国大陆主机访问 GitHub 常年 clone 超时，这时正确做法是让用户手动装 zip。',
        params: {
            url: 'string 仓库地址',
            confirm: 'boolean 必填 true；用户没明确同意安装时不要传',
        },
        run: async a => {
            if (a.confirm !== true) {
                return {
                    ok: false,
                    blocked: true,
                    reason: '安装扩展要用户明确同意：确认后再调用本工具并传 confirm:true',
                    hint: '不要为了“让 MVU 能跑”自己去装扩展 —— MVU 根本不需要扩展，缺本体就用 mvu.runtime 写那条 bundle 脚本。真要装别的扩展，先问用户。',
                };
            }
            const r = await api('/api/extensions/install', { url: a.url }, { timeout: INSTALL_TIMEOUT_MS });
            return { ok: true, url: a.url, response: r, note: '刷新页面后生效；若本次等了很久，说明主机拉 GitHub 很慢，下次优先让用户手动装 zip' };
        },
    },
    {
        name: 'extension.delete',
        kind: 'dangerous',
        desc: '删除一个扩展目录（需确认）。装扩展失败了不要靠反复 delete 来“重试”：同一目录连续删不会有新结果，只会刷屏并拖住任务。真删之前先问用户。',
        params: { name: 'string 扩展 id（如 third-party/xxx）', confirm: 'boolean 必填 true' },
        run: async a => {
            if (a.confirm !== true) {
                return { ok: false, blocked: true, reason: '删除扩展目录要用户明确同意：确认后再传 confirm:true', hint: '反复删除同名目录不会修好安装失败；先看 extension.list 的真实状态，再决定' };
            }
            await api('/api/extensions/delete', { extensionName: a.name });
            return { ok: true, deleted: a.name };
        },
    },

    /* ---------------- 正则 / 脚本 ---------------- */
    {
        name: 'regex.list',
        kind: 'read',
        desc: '列出正则脚本，分两处：global（extension_settings.regex，全剧通用）与 scoped（当前角色卡的 data.extensions.regex_scripts，只跟着这张卡）。返回里每条都带 scope；scoped 还带 character 与 allowed（allowed=false 表示这张卡的正则开关没打开，一条都不会生效）。',
        params: { card: 'string 可选，头像文件名，留空用当前角色' },
        run: async a => {
            const ch = charBy(a.card);
            return allRegexes(ch).map(r => ({
                scope: r.scope,
                character: r.character || undefined,
                allowed: r.scope === 'scoped' ? scopedAllowed(ch) : undefined,
                scriptName: r.scriptName,
                findRegex: r.findRegex,
                replaceString: String(r.replaceString || '').slice(0, 200),
                placement: r.placement,
                disabled: r.disabled,
                markdownOnly: r.markdownOnly,
                promptOnly: r.promptOnly,
            }));
        },
    },
    {
        name: 'regex.upsert',
        kind: 'write',
        desc: '按脚本名新增或更新一条正则。**默认写进当前角色卡的正则位（scoped），不是全局**——给某张卡做的状态栏美化、清理标记、MVU 隐藏占位符都必须挂在这张卡上，写到全局会连别的卡一起改。要写全剧通用正则时显式传 scope:"global"。'
            + 'placement 必须落成数字（USER_INPUT=1、AI_OUTPUT=2、SLASH_COMMAND=3、WORLD_INFO=5、REASONING=6；写字符串会被 script.placement.includes(数字) 判成不匹配，正则表面存在却完全不生效）。'
            + 'markdownOnly=只在显示层替换（状态栏美化）、promptOnly=只在发给模型前替换（隐藏标记）。写卡级时会自动打开这张卡的正则开关（character_allowed_regex），不开闸的正则在卡里躺着也永远不跑。',
        params: {
            scriptName: 'string 脚本名',
            findRegex: 'string 查找正则，形如 /pattern/flags',
            replaceString: 'string 替换内容（支持 $1 与 {{match}}）',
            placement: 'array 字符串名或数字，如 ["AI_OUTPUT"] 或 [2]',
            scope: 'string 可选：card（默认，写当前角色卡）或 global（全剧通用）',
            card: 'string 可选，头像文件名，scope=card 时指定写哪张卡，留空用当前角色',
            disabled: 'boolean 可选',
            markdownOnly: 'boolean 可选，只在显示层生效（不改变发给模型的正文）',
            promptOnly: 'boolean 可选，只在发送给模型前生效',
            runOnEdit: 'boolean 可选，编辑消息时也执行',
            substituteRegex: 'number 可选，findRegex 里宏替换方式：0=不替换 1=替换为原文 2=替换为转义文本',
        },
        run: async a => {
            if (!a.scriptName) throw new Error('需要 scriptName');
            if (!a.findRegex) throw new Error('需要 findRegex（形如 /pattern/flags）');
            const flags = {};
            if (a.markdownOnly !== undefined) flags.markdownOnly = !!a.markdownOnly;
            if (a.promptOnly !== undefined) flags.promptOnly = !!a.promptOnly;
            if (a.runOnEdit !== undefined) flags.runOnEdit = !!a.runOnEdit;
            if (a.substituteRegex !== undefined) flags.substituteRegex = Number(a.substituteRegex);
            if (a.disabled !== undefined) flags.disabled = !!a.disabled;

            const wantGlobal = String(a.scope || '').toLowerCase() === 'global';
            if (!wantGlobal) {
                const ch = charBy(a.card);
                if (!ch) {
                    // v1.42：不再静默退回全局 —— 全局正则对所有卡生效，是「所有卡被插件影响」的头号通道
                    throw new Error('没有目标角色卡（群聊/欢迎页/未开卡）：卡级正则无处可挂。请显式传 card（char.list 取 avatar）；确实要给所有卡用才写 scope:"global"，并清楚它会连别的卡一起改');
                }
                const got = await upsertScoped(ch, {
                    scriptName: a.scriptName,
                    findRegex: a.findRegex,
                    replaceString: a.replaceString ?? '',
                    placement: toPlacement(a.placement),
                    ...flags,
                });
                return {
                    ok: true,
                    scope: 'scoped',
                    character: got.avatar,
                    created: got.created,
                    allow_open: got.opened,
                    scriptName: a.scriptName,
                    placement: got.item.placement,
                    total_in_card: got.total,
                    flags: { markdownOnly: !!got.item.markdownOnly, promptOnly: !!got.item.promptOnly, runOnEdit: !!got.item.runOnEdit },
                    note: '已写进角色卡正则位（正则 → Scoped 页签），只对这张卡生效；开关已自动打开。',
                };
            }

            const x = c();
            x.extensionSettings = x.extensionSettings || {};
            const list = x.extensionSettings.regex || (x.extensionSettings.regex = []);
            let item = list.find(r => r.scriptName === a.scriptName);
            const created = !item;
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
                scope: 'global',
                created,
                scriptName: a.scriptName,
                placement: item.placement,
                flags: { markdownOnly: !!item.markdownOnly, promptOnly: !!item.promptOnly, runOnEdit: !!item.runOnEdit },
                note: '已写全局正则（extension_settings.regex）：对所有角色生效。',
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
