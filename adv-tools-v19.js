/**
 * v1.9 工具层：连接层、图库、导入导出。
 *
 * 前面八版有个共同的空缺：Agent 能改角色卡、世界书、聊天、设置，却**不知道自己
 * 现在接的是哪个模型、这个 key 有没有配、这个端点还剩多少上下文**。这一版补的就是
 * 「自我认知」和「资产搬运」：
 *
 *   1. 连接层（/api/secrets/*、/api/backends/chat-completions/status）
 *      —— 读当前 main_api/source/model、列出已配置的密钥（服务端脱敏后的值）、
 *         写/换密钥、拉当前 source 的模型列表（这同时就是一次真实连通性测试）。
 *         切 source/模型走 oai_settings 内存 + saveSettingsDebounced，立即生效。
 *   2. 图库（/api/image-metadata/*）—— 酒馆 1.13+ 的图片元数据索引：文件夹、
 *      归类、孤立条目清理。给「把这几张图归到某个文件夹」这种需求用。
 *   3. 资产搬运（/api/files/*、/api/presets/restore、/api/themes/save）
 *      —— 上传附件到酒馆文件区、恢复出厂预设、把整套主题落盘。
 *   4. 酒馆内置翻译（/api/translate/*）—— 不消耗聊天额度就能翻一段文本。
 *
 * 设计原则同前几版：只走酒馆自己已有的接口，不改 config.yaml，不碰 secrets 明文
 * （view 需要 allowKeysExposure，这里只用 read 的脱敏状态）。
 */
import { getContext } from '../../../extensions.js';

const c = () => getContext();

/* ------------------------------ HTTP ------------------------------ */

async function call(url, body) {
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

/** 端点选择：/status 需要的字段从前端 oai_settings 拷过去，避免手搓。 */
const STATUS_FIELDS = [
    'chat_completion_source', 'reverse_proxy', 'proxy_password', 'custom_url',
    'custom_include_headers', 'azure_base_url', 'azure_api_version', 'azure_deployment_name',
    'claude_endpoint', 'vertexai_auth_mode', 'vertexai_region', 'vertexai_project_id',
    'vertexai_service_account_json', 'vertexai_model', 'google_model', 'openai_model',
];

/* ------------------------------ 连接层 ------------------------------ */

async function apiState() {
    const ctx = c();
    const oai = ctx.chatCompletionSettings || {};
    const tc = ctx.textCompletionSettings || {};
    let saved = {};
    try { saved = await call('/api/settings/get', {}) || {}; } catch { /* 只读兜底 */ }

    const mainApi = ctx.mainApi || saved.main_api || '(未知)';
    const source = oai.chat_completion_source || '';
    let model = '';
    try {
        model = typeof ctx.getChatCompletionModel === 'function' ? (ctx.getChatCompletionModel() || '') : '';
    } catch { model = ''; }
    if (!model && source) model = oai[`${source}_model`] || oai.openai_model || '';

    // 文本补全后端
    const tcType = tc.type || saved?.textgenerationwebui_settings?.type || '';
    const tcServer = (tc.server_urls && (tc.server_urls[tcType] || tc.server_urls.default)) || '';

    const secrets = await call('/api/secrets/read', {}).catch(() => ({}));
    const configured = {};
    for (const [key, list] of Object.entries(secrets || {})) {
        if (!Array.isArray(list) || list.length === 0) continue;
        configured[key] = list.map(s => ({ id: s.id, value: s.value, label: s.label, active: s.active }));
    }

    return {
        main_api: mainApi,
        chat_completion_source: source || null,
        // 这是「API 连接 → 聊天补全」里存的模型，只有 main_api 为 openai 时才是真正在跑的那个
        chat_completion_model: model || null,
        text_completion: tcType ? { type: tcType, server: tcServer || null } : null,
        reverse_proxy: oai.reverse_proxy ? '(已设置)' : '(未设置)',
        streaming: !!oai.stream_openai,
        max_context: oai.openai_max_context ?? tc.max_context ?? saved.openai_max_context ?? null,
        max_tokens: oai.openai_max_tokens ?? tc.max_tokens ?? saved.openai_max_tokens ?? null,
        presets: {
            chat: oai.preset_settings_openai || saved.preset_settings_openai || null,
            text: tc.preset_settings || saved.preset_settings || null,
        },
        secrets_configured: configured,
        secrets_note: '密钥值已被服务端脱敏（只回前几位），明文要 config.yaml 的 allowKeysExposure: true。',
        hint: `当前接的是 ${mainApi}${source ? ' / 聊天补全源 ' + source : ''}${model ? ' / ' + model : ''}。注意 chat_completion_model 只在 main_api 为 openai 时才真正生效；换模型用 api.switch，先看可选清单用 api.models。`,
    };
}

async function apiModels({ source, url } = {}) {
    const oai = c().chatCompletionSettings || {};
    const src = source || oai.chat_completion_source || 'openai';
    const body = { secret_id: '' };
    for (const f of STATUS_FIELDS) {
        if (oai[f] !== undefined && oai[f] !== null) body[f] = oai[f];
    }
    body.chat_completion_source = src;
    if (url) {
        body.reverse_proxy = url;
        body.custom_url = url;
    }

    let res;
    try {
        res = await call('/api/backends/chat-completions/status', body);
    } catch (e) {
        return {
            ok: false, source: src, error: String(e.message || e),
            hint: '这次请求没打通。401/403 = 该 source 的密钥未配置或失效，先在「API 连接」页确认，或用 api.key 写入。',
        };
    }
    const list = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
    const ids = list.map(m => (typeof m === 'string' ? m : m?.id)).filter(Boolean);

    return {
        ok: !res?.error && ids.length > 0,
        source: src,
        count: ids.length,
        models: ids.slice(0, 60),
        truncated: ids.length > 60,
        error: res?.error ? true : false,
        message: res?.message || null,
        hint: ids.length
            ? '这既是模型清单，也是一次真实连通性测试（能列出模型 = key 与端点都好用）。选中后用 api.switch 切过去。'
            : '没拿到模型。key 未配置 / 端点不可达 / 该 source 不需要模型列表（如 kobold、textgenerationwebui）。',
    };
}

async function apiKey({ key, value, label } = {}) {
    if (!key || typeof value !== 'string' || !value) throw new Error('key 与 value 都必须给（value 传明文，服务端负责加密落盘）');
    const r = await call('/api/secrets/write', { key, value, label: label || null });
    return {
        ok: true,
        key,
        id: r?.id ?? null,
        bytes: value.length,
        hint: '已写入 secrets（返回的 id 是这条密钥的标识，值不回显）。当前会话若已缓存旧 key，刷新页面后前端才会重新读。',
    };
}

async function apiSecrets({ onlyConfigured = true } = {}) {
    const state = await call('/api/secrets/read', {});
    const rows = [];
    for (const [key, list] of Object.entries(state || {})) {
        if (!Array.isArray(list)) continue;
        if (onlyConfigured && list.length === 0) continue;
        rows.push({
            key,
            count: list.length,
            items: list.map(s => ({ id: s.id, masked: s.value, label: s.label, active: s.active })),
        });
    }
    rows.sort((a, b) => a.key.localeCompare(b.key));
    return {
        count: rows.length,
        secrets: rows,
        hint: onlyConfigured ? '只列已配置的密钥（值为服务端脱敏后的）。要写新的用 api.key。' : '含未配置的空键。',
    };
}

async function apiSwitch({ mainApi, source, model } = {}) {
    const ctx = c();
    const oai = ctx.chatCompletionSettings;
    const changed = [];
    let needsReload = false;

    if (mainApi) {
        const all = await call('/api/settings/get', {});
        if (all.main_api !== mainApi) {
            all.main_api = mainApi;
            await call('/api/settings/save', all);
            changed.push(`main_api → ${mainApi}`);
            needsReload = true;
        }
    }

    if (source) {
        if (!oai) throw new Error('拿不到 chatCompletionSettings');
        oai.chat_completion_source = source;
        changed.push(`source → ${source}`);
    }

    if (model) {
        if (!oai) throw new Error('拿不到 chatCompletionSettings');
        const src = source || oai.chat_completion_source || 'openai';
        let field = `${src}_model`;
        if (!Object.prototype.hasOwnProperty.call(oai, field)) {
            field = 'openai_model';
        }
        oai[field] = model;
        changed.push(`${field} → ${model}`);
    }

    if (changed.length && (source || model)) {
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    }

    return {
        ok: changed.length > 0,
        changed,
        needs_reload: needsReload,
        current: {
            main_api: ctx.mainApi,
            source: oai?.chat_completion_source,
            model: (() => { try { return ctx.getChatCompletionModel?.() || null; } catch { return null; } })(),
        },
        hint: needsReload
            ? 'main_api 是模块级变量，改完写盘了但前端内存要刷新页面才切过去；source/model 是立即生效的。'
            : (changed.length ? '已生效并落盘。' : '什么都没给，无事可做。参数：mainApi / source / model。'),
    };
}

/* ------------------------------ 图库 ------------------------------ */

async function imgIndex({ prefix, preview = 15 } = {}) {
    const idx = await call('/api/image-metadata/all', { prefix: prefix || '' });
    const files = Object.keys(idx?.images || {});
    const folders = Array.isArray(idx?.folders) ? idx.folders : [];
    const byFolder = {};
    for (const f of folders) byFolder[f.name || f.id] = 0;
    for (const meta of Object.values(idx?.images || {})) {
        const fid = meta?.folderId || meta?.folder_id;
        if (fid) {
            const f = folders.find(x => x.id === fid);
            const name = f?.name || fid;
            byFolder[name] = (byFolder[name] || 0) + 1;
        }
    }
    const tagged = Object.values(idx?.images || {}).filter(m => Array.isArray(m?.tags) && m.tags.length).length;
    return {
        version: idx?.version ?? null,
        file_count: files.length,
        folder_count: folders.length,
        folders: folders.map(f => ({ id: f.id, name: f.name, files: byFolder[f.name] || 0 })),
        tagged_files: tagged,
        sample: files.slice(0, preview),
        hint: '这是酒馆的图片元数据索引（不扫真实文件夹，只读 metadata 库）。归类用 img.assign，清孤立条目用 img.cleanup。',
    };
}

async function imgFolders() {
    const folders = await call('/api/image-metadata/folders/get', {});
    return { count: Array.isArray(folders) ? folders.length : 0, folders };
}

async function imgFolderCreate({ name } = {}) {
    if (!name) throw new Error('需要 name');
    const folder = await call('/api/image-metadata/folders/create', { name: String(name).trim() });
    return { ok: true, folder, hint: '新建后把图塞进去用 img.assign { id, paths }。' };
}

async function imgAssign({ id, paths, action = 'assign' } = {}) {
    if (!id) throw new Error('需要 folder id（先用 img.folders 拿）');
    if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths 必须是非空数组（相对 data/<user>/ 的路径）');
    const ep = action === 'unassign' ? 'unassign' : 'assign';
    await call(`/api/image-metadata/folders/${ep}`, { id, paths });
    return { ok: true, action: ep, folder: id, count: paths.length };
}

async function imgCleanup() {
    const before = await call('/api/image-metadata/folders/get', {});
    const r = await call('/api/image-metadata/cleanup', {});
    return {
        ok: true,
        removed: r?.count ?? (Array.isArray(r?.removed) ? r.removed.length : 0),
        removed_sample: Array.isArray(r?.removed) ? r.removed.slice(0, 10) : [],
        folders_before: Array.isArray(before) ? before.length : 0,
        note: '只清“文件已经不在了”的元数据条目，不删任何真实图片；服务端没有预演模式，调用即执行。',
    };
}

/* ------------------------------ 资产搬运 ------------------------------ */

async function fileUpload({ name, base64 } = {}) {
    if (!name) throw new Error('需要 name（文件名，不能带路径）');
    if (!base64 || typeof base64 !== 'string') throw new Error('需要 base64（纯 base64，不要带 data: 前缀）');
    const clean = base64.replace(/^data:[^;]+;base64,/i, '');
    const r = await call('/api/files/upload', { name, data: clean });
    return {
        ok: true,
        name,
        path: r?.path ?? null,
        kb: Math.round(clean.length * 0.75 / 1024),
        hint: '返回的 path 形如 /user/files/…，可以直接填进角色卡字段、消息里的图片链接，或 assets 校验。',
    };
}

async function fileDelete({ path, confirm } = {}) {
    if (!path) throw new Error('需要 path（/api/files/verify 或 file.upload 返回的那种）');
    if (confirm !== true) return { ok: false, skipped: true, reason: '需要 confirm: true（删文件不可撤销）' };
    await call('/api/files/delete', { path });
    return { ok: true, path };
}

async function presetReset({ apiId = 'openai', name } = {}) {
    if (!name) throw new Error('需要 name（预设名，如 Default）');
    const r = await call('/api/presets/restore', { apiId, name });
    const preset = r?.preset || {};
    return {
        is_default: !!r?.isDefault,
        apiId,
        name,
        keys: Object.keys(preset),
        preset,
        hint: '这个接口只把“出厂预设”的内容返回来，不会覆盖你现在的预设。想真恢复：把它整份喂给 preset.save { apiId, name, preset }。',
    };
}

async function themeSave({ name, theme } = {}) {
    if (!name) throw new Error('需要 name（主题名）');
    if (!theme || typeof theme !== 'object') throw new Error('需要 theme（主题变量对象：main_text、blur_strength、shadow 等）');
    const body = { ...theme, name };
    await call('/api/themes/save', body);
    return {
        ok: true,
        name,
        keys: Object.keys(body).length,
        hint: '已落到 data/<user>/themes/<name>.json。要立刻生效：改 powerUserSettings.theme 再刷新，或直接重新应用（酒馆没暴露 applyTheme）。',
    };
}

async function translateRun({ text, lang, provider = 'google' } = {}) {
    if (!text) throw new Error('需要 text');
    if (!lang) throw new Error('需要 lang（目标语言代码，如 zh-CN / en / ja）');
    const allowed = ['google', 'libre', 'yandex', 'lingva', 'deepl', 'deeplx', 'bing'];
    if (!allowed.includes(provider)) throw new Error(`provider 只能是 ${allowed.join(' / ')}`);
    const r = await call(`/api/translate/${provider}`, { text: String(text), lang });
    if (typeof r !== 'string') throw new Error('翻译接口返回结构异常：' + JSON.stringify(r).slice(0, 120));
    return { ok: true, provider, lang, chars: String(text).length, text: r };
}

/* ------------------------------ 工具定义 ------------------------------ */

export const TOOLS = [
    {
        name: 'api.state', kind: 'read',
        desc: '读当前连的是哪个后端：main_api、chat_completion_source、正在用的模型、端点、上下文与 token 上限、当前预设，以及已配置了哪些密钥（值由服务端脱敏）。Agent 动手前先用它确认“我现在到底能生成什么”。',
        params: {},
        run: () => apiState(),
    },
    {
        name: 'api.models', kind: 'read',
        desc: '拉当前 source（或指定 source）的可用模型列表，等价于酒馆「连接」按钮干的事——同时也是最真实的连通性测试：能列出模型说明 key 与端点都好用。',
        params: { source: '覆写 chat_completion_source（openai / claude / openrouter / deepseek / custom …）', url: '临时覆写端点地址（自建反代）' },
        run: a => apiModels(a),
    },
    {
        name: 'api.key', kind: 'write',
        desc: '写入/更换某个后端密钥（走 /api/secrets/write，服务端加密落盘，不回显）。key 用酒馆自己的名字，如 api_key_openai、api_key_claude、api_key_deepseek、api_key_custom。',
        params: { key: '密钥键名，如 api_key_openai', value: '明文密钥', label: '可选备注' },
        run: a => apiKey(a),
    },
    {
        name: 'api.secrets', kind: 'read',
        desc: '列出 secrets 里已配置的密钥条目（仅脱敏值 + label + 是否 active）。回答“哪个后端的 key 到底配过没有”用它，不用翻设置页。',
        params: { onlyConfigured: '默认 true，只看已配置的' },
        run: a => apiSecrets(a),
    },
    {
        name: 'api.switch', kind: 'write',
        desc: '切换主 API / chat_completion_source / 模型。source 与 model 改 oai_settings 并立刻 saveSettingsDebounced（立即生效）；mainApi 写盘生效但前端要刷新页面。',
        params: { mainApi: 'openai / textgenerationwebui / kobold / koboldhorde …', source: 'chat completion 源', model: '模型名（会自动写到 <source>_model）' },
        run: a => apiSwitch(a),
    },
    {
        name: 'img.index', kind: 'read',
        desc: '读酒馆图片元数据索引：总图数、文件夹与各自归了几张、打了标签的有几张，并抽样列出路径。比 audit.run 更聚焦图库本身。',
        params: { prefix: '只统计某个路径前缀，如 backgrounds/', preview: '抽样几条，默认 15' },
        run: a => imgIndex(a),
    },
    {
        name: 'img.folders', kind: 'read',
        desc: '列图片元数据里的所有文件夹（id / 名称 / 封面缩略图）。',
        params: {},
        run: () => imgFolders(),
    },
    {
        name: 'img.folderCreate', kind: 'write',
        desc: '新建一个图片文件夹（酒馆图库里的分类），返回 folder 对象（含 id）。',
        params: { name: '文件夹名' },
        run: a => imgFolderCreate(a),
    },
    {
        name: 'img.assign', kind: 'write',
        desc: '把一批图片路径归入/移出某个文件夹（批量）。路径是相对 data/<user>/ 的路径，如 characters/Seraphina.png。',
        params: { id: '文件夹 id', paths: '路径数组', action: 'assign（默认）/ unassign' },
        run: a => imgAssign(a),
    },
    {
        name: 'img.cleanup', kind: 'write',
        desc: '清掉图片元数据里“文件早就不在了”的孤立条目（只动元数据，不删真实图片，且不可预演）。',
        params: {},
        run: () => imgCleanup(),
    },
    {
        name: 'file.upload', kind: 'write',
        desc: '把 base64 内容写成酒馆文件区的文件（/api/files/upload），返回 /user/files/… 路径。适合把外部素材塞进酒馆，之后能在角色卡、消息里引用。',
        params: { name: '文件名（不含路径）', base64: '纯 base64（可容忍 data: 前缀，会自动去掉）' },
        run: a => fileUpload(a),
    },
    {
        name: 'file.delete', kind: 'dangerous',
        desc: '删掉酒馆文件区里的一个文件（只允许 files 目录内的 /user/files/… 路径）。不可撤销，必须 confirm: true。',
        params: { path: '/user/files/… 路径', confirm: '必须 true' },
        run: a => fileDelete(a),
    },
    {
        name: 'preset.restore', kind: 'read',
        desc: '取出厂预设的原始内容（只读，不覆盖你现有的）。想真恢复时把返回的 preset 整份交给 preset.save。',
        params: { apiId: 'openai / textgeneration / instruct / context / reasoning', name: '预设名' },
        run: a => presetReset(a),
    },
    {
        name: 'theme.save', kind: 'write',
        desc: '把一整套主题变量落盘成 data/<user>/themes/<name>.json（含颜色、模糊度、阴影等）。用于备份当前主题、或把做好的主题带到别的机器。',
        params: { name: '主题名', theme: '主题变量对象' },
        run: a => themeSave(a),
    },
    {
        name: 'translate.run', kind: 'read',
        desc: '用酒馆内置翻译后端翻一段文本（不消耗聊天额度）。支持 google / libre / yandex / lingva / deepl / deeplx / bing；若 google 报 500（墙或端点不通），换 bing 通常可用。',
        params: { text: '要翻的文本', lang: '目标语言，如 zh-CN / en / ja', provider: '默认 google' },
        run: a => translateRun(a),
    },
];
