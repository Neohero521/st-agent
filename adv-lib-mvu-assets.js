/**
 * MVU 固定资产（照抄 我的写卡器-v329.59.js）
 *
 * 写卡器在「写入酒馆」时固定写 6 条正则 + 2 份脚本，id 与字段全部固定：
 *   d668c8a6… 仅格式思维链        （promptOnly，把 <Analysis> 从提示词里剥掉）
 *   5bb4b588… 只发送最新2楼的变量更新（promptOnly，minDepth=4，剥离旧楼变量补丁）
 *   6fb572ae… [美化]变量完成       （markdownOnly，把 <UpdateVariable> 折叠成卡片）
 *   bf1b7441… [美化]变量更新中     （markdownOnly，流式未闭合时显示"正在变量更新"）
 *   mvu-status-hide [不发送]隐藏状态栏标记（promptOnly）
 *   mvu-status-bar  [美化]MVU状态栏      （markdownOnly，runOnEdit=true）
 * 两条状态栏正则的 findRegex 都是 /<StatusPlaceHolderImpl\/>/g；美化那条的 replaceString
 * 必须是 ```html 包裹（酒馆助手按 fence 渲染状态栏，裸 HTML 不建 iframe —— 这是"状态栏不显示"的常见原因）。
 */

export const MVU_RUNTIME_ID = '961f366d-e403-45c2-8155-3d14ec86de53';
export const MVU_RUNTIME_NAME = 'MVU';
export const MVU_RUNTIME_URL = 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';
export const MVU_SCHEMA_ID = 'mvu-schema';
export const MVU_SCHEMA_NAME = '变量结构';
export const MVU_SCHEMA_IMPORT = "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';";

export const FIXED_MVU_REGEX_IDS = [
    'd668c8a6-fa6a-444d-a5d6-8f68b73a3c36',
    '5bb4b588-23ca-4564-8df5-882104eff764',
    '6fb572ae-a9ea-436d-9779-ad100f1ff7f5',
    'bf1b7441-5cf1-426d-bd6c-911332be9923',
    'mvu-status-hide',
    'mvu-status-bar',
];

/** 状态栏 HTML 包裹：写卡器 _wrapHtml 同款（去围栏 → ```html 包回来） */
export function wrapHtml(html) {
    let s = String(html || '').trim();
    if (!s) return '';
    while (/^```[^\n]*\n/.test(s)) s = s.replace(/^```[^\n]*\n/, '');
    s = s.replace(/\n```\s*$/, '');
    s = s.replace(/^\s*html[ \t]*\r?\n/i, '').replace(/^\s+/, '');
    return '```html\n' + s + '\n```';
}

/** 剥掉多余的围栏（世界书条目里存纯 HTML） */
export function unwrapHtml(html) {
    let s = String(html || '').trim();
    while (/^```[^\n]*\n/.test(s)) s = s.replace(/^```[^\n]*\n/, '');
    s = s.replace(/\n```\s*$/, '');
    return s;
}

/** 6 条固定正则（ST 正则字段名；statusBarHtml 传纯 HTML，内部自动 ```html 包裹） */
export function fixedMvuRegexes(statusBarHtml) {
    return [
        {
            id: FIXED_MVU_REGEX_IDS[0],
            scriptName: '仅格式思维链',
            findRegex: '/<Analysis>[\\s\\S]+?<\\/Analysis>/gm',
            replaceString: '',
            placement: [2],
            markdownOnly: false,
            promptOnly: true,
            runOnEdit: false,
            minDepth: null,
            maxDepth: null,
        },
        {
            id: FIXED_MVU_REGEX_IDS[1],
            scriptName: '只发送最新2楼的变量更新',
            findRegex: '/<(UpdateVariable|JSONPatch|initvar)>[\\s\\S]*?<\\/\\1>/gm',
            replaceString: '',
            placement: [2],
            markdownOnly: false,
            promptOnly: true,
            runOnEdit: false,
            minDepth: 4,
            maxDepth: null,
        },
        {
            id: FIXED_MVU_REGEX_IDS[2],
            scriptName: '[美化]变量完成',
            findRegex: '/<UpdateVariable(?:variable)?>\\s*([\\s\\S]*?)\\s*<\\/UpdateVariable(?:variable)?>/gsi',
            replaceString: NEKO_COMPLETE_HTML,
            placement: [2],
            markdownOnly: true,
            promptOnly: false,
            runOnEdit: false,
            minDepth: null,
            maxDepth: null,
        },
        {
            id: FIXED_MVU_REGEX_IDS[3],
            scriptName: '[美化]变量更新中',
            findRegex: '/<UpdateVariable(?:variable)?>(?!.*<\\/UpdateVariable(?:variable)?>)\\s*(.*)\\s*$/gsi',
            replaceString: NEKO_THINKING_HTML,
            placement: [2],
            markdownOnly: true,
            promptOnly: false,
            runOnEdit: false,
            minDepth: null,
            maxDepth: null,
        },
        {
            id: FIXED_MVU_REGEX_IDS[4],
            scriptName: '[不发送]隐藏状态栏标记',
            findRegex: '/<StatusPlaceHolderImpl\\/>/g',
            replaceString: '',
            placement: [2],
            markdownOnly: false,
            promptOnly: true,
            runOnEdit: false,
            minDepth: null,
            maxDepth: null,
        },
        {
            id: FIXED_MVU_REGEX_IDS[5],
            scriptName: '[美化]MVU状态栏',
            findRegex: '/<StatusPlaceHolderImpl\\/>/g',
            // 条目里留 <StatusPlaceHolderImpl/> 当锚；replaceString 必须把它剥掉，否则替换结果里又出现占位符（二次触发/漏文字）
            replaceString: wrapHtml(String(statusBarHtml).replace(/<StatusPlaceHolderImpl\s*\/>/gi, '').trim()),
            placement: [2],
            markdownOnly: true,
            promptOnly: false,
            runOnEdit: true,
            minDepth: null,
            maxDepth: null,
        },
    ];
}

/** 变量结构脚本：只给 z.object 正文，自动补 import 头与 registerMvuSchema 注册尾（写卡器同款） */
export function buildSchemaScript(body) {
    let s = String(body || '').trim();
    s = s.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '');
    // 去掉裸 import { z }（z 在酒馆助手 iframe 里是全局，裸 import 会崩）
    s = s.replace(/^\s*import\s*\{[^}]*\}\s*from\s*['"]zod['"];?\s*$/gm, '');
    if (/import\s*\{[^}]*registerMvuSchema[^}]*\}/.test(s)) {
        s = s.replace(/^\s*import\s*\{[^}]*registerMvuSchema[^}]*\}\s*from\s*['"][^'"]+['"];?\s*$/gm, '').trim();
    }
    if (/export\s+const\s+Schema\s*=/.test(s)) {
        // 只留 export const Schema = ...（到文件尾）
        const i = s.search(/export\s+const\s+Schema\s*=/);
        s = s.slice(i);
    } else {
        s = 'export const Schema = ' + (s.startsWith('z.object') ? s : s);
    }
    // 去掉已有的注册尾，统一重加
    s = s.replace(/\$\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?registerMvuSchema[\s\S]*?\}\s*\)\s*;?/g, '').trim();
    s = s.replace(/;\s*$/, '');
    return MVU_SCHEMA_IMPORT + '\n\n' + s + ';\n\n$(() => {\n    registerMvuSchema(Schema);\n});';
}

export const NEKO_COMPLETE_HTML = '<div style="text-align:center;margin:10px 0;width:100%;max-width:680px">\n<div style="display:inline-block;width:100%;text-align:left">\n  <details class="status-notice" style="border:none;background:none;margin:0">\n    <summary style="list-style:none;cursor:pointer;display:flex;align-items:center;gap:0;padding:0;width:100%">\n      <span style="flex:1;display:flex;align-items:center;height:34px;padding:0 18px;background:linear-gradient(135deg,var(--accent-soft) 0%,var(--accent-soft-strong) 100%);border:1px solid var(--accent-border);border-radius:14px;box-shadow:0 2px 8px rgba(65,118,230,0.12);position:relative;z-index:2">\n        <span style="flex:1;font-size:0.92em;font-weight:600;color:var(--ink)">变量完成</span>\n        <small style="font-size:0.78em;color:var(--muted);margin-left:10px"><span class="toggle-btn" data-close="展开 ▶" data-open="收起 ▼"></span></small>\n      </span>\n    </summary>\n    <!-- 内容面板：高对比浅灰蓝底+深灰字，确保括号/列表/JSON全部清晰 -->\n    <div style="width:100%;max-height:360px;overflow-y:auto;margin:7px 0 0 0;padding:12px 18px;color:var(--ink);line-height:1.78;white-space:pre-wrap;background:var(--surface-soft);border:1px solid var(--line);border-radius:12px;font-size:0.92em;box-shadow:var(--shadow-soft)">\n    $1\n    </div>\n  </details>\n</div>\n</div>\n\n<style>\n  .status-notice summary::marker { display: none; }\n  .status-notice[open] > div { animation: slideUp 0.35s ease forwards; }\n  .status-notice[open] .toggle-btn::after { content: attr(data-open); }\n  .status-notice:not([open]) .toggle-btn::after { content: attr(data-close); }\n  /* 内容区嵌套元素增强：列表、括号、JSON代码块全部加强对比度 */\n  .status-notice ul, .status-notice ol { padding-left: 22px; color: var(--ink); }\n  .status-notice li { margin: 3px 0; color: var(--ink); }\n  .status-notice code, .status-notice pre { font-size: 0.88em; color: var(--ink); background: var(--surface-sink); border: 1px solid var(--line); border-radius: 5px; padding: 2px 5px; }\n  .status-notice pre { padding: 8px 12px; overflow-x: auto; }\n  .status-notice strong, .status-notice b { color: #0f172a; }\n  @keyframes slideUp {\n    from { opacity: 0; transform: translateY(-6px); }\n    to { opacity: 1; transform: translateY(0); }\n  }\n</style>';

export const NEKO_THINKING_HTML = '<div style="text-align:center;margin:10px 0;width:100%;max-width:680px">\n<div style="display:inline-block;width:100%;text-align:left">\n  <details class="loading-notice" style="border:none;background:none;margin:0">\n    <summary style="list-style:none;cursor:pointer;display:flex;align-items:center;gap:0;padding:0;width:100%">\n      <span style="flex:1;display:flex;align-items:center;height:34px;padding:0 18px;background:linear-gradient(135deg,var(--accent-soft) 0%,var(--accent-soft-strong) 100%);border:1px solid var(--accent-border);border-radius:14px;box-shadow:0 2px 8px rgba(65,118,230,0.12);position:relative;overflow:hidden;z-index:2">\n        <span style="flex:1;font-size:0.92em;font-weight:600;color:var(--ink)">正在变量更新</span>\n        <small style="font-size:0.78em;color:var(--muted);margin-left:10px"><span class="toggle-btn" data-close="展开 ▶" data-open="收起 ▼"></span></small>\n        <span class="flow-light" style="position:absolute;top:0;left:0;width:100%;height:100%;background:linear-gradient(90deg,transparent,var(--accent-soft-strong),transparent);animation:slide-flow 3s linear infinite;pointer-events:none"></span>\n      </span>\n    </summary>\n    <div style="width:100%;max-height:360px;overflow-y:auto;margin:7px 0 0 0;padding:12px 18px;color:var(--ink);line-height:1.78;white-space:pre-wrap;background:var(--surface-soft);border:1px solid var(--line);border-radius:12px;font-size:0.92em;box-shadow:var(--shadow-soft)">\n    $1\n    </div>\n  </details>\n</div>\n</div>\n\n<style>\n  .loading-notice summary::marker { display: none; }\n  .loading-notice[open] .flow-light { animation: none; opacity: 0; }\n  .loading-notice[open] > div { animation: slideUp 0.35s ease forwards; }\n  .loading-notice[open] .toggle-btn::after { content: attr(data-open); }\n  .loading-notice:not([open]) .toggle-btn::after { content: attr(data-close); }\n  /* 内容区嵌套元素增强 */\n  .loading-notice ul, .loading-notice ol { padding-left: 22px; color: var(--ink); }\n  .loading-notice li { margin: 3px 0; color: var(--ink); }\n  .loading-notice code, .loading-notice pre { font-size: 0.88em; color: var(--ink); background: var(--surface-sink); border: 1px solid var(--line); border-radius: 5px; padding: 2px 5px; }\n  .loading-notice pre { padding: 8px 12px; overflow-x: auto; }\n  .loading-notice strong, .loading-notice b { color: #0f172a; }\n  @keyframes slide-flow {\n    0% { transform: translateX(-100%); }\n    100% { transform: translateX(100%); }\n  }\n  @keyframes slideUp {\n    from { opacity: 0; transform: translateY(-6px); }\n    to { opacity: 1; transform: translateY(0); }\n  }\n</style>';
