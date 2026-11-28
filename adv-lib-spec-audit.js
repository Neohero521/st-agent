/**
 * 规范 + 体检：把写卡器的「正确写法」变成可执行检查（不是再抄一遍模板）
 *
 * 来源：写卡器 v329.59 的 feSpecBlock / FE_SPEC_L1 / SCRIPT_VS_REGEX_RULE / 条目诊断逻辑。
 * 四类对象各自的"正确"定义：
 *   前端（正则）   → 完整 HTML 文档、核心函数不许删、正则勾选 [2]/markdown/runOnEdit、禁 <khl>/<thinking>/<content>
 *   状态栏         → 完整文档 + waitGlobalInitialized('Mvu') + eventOn(VARIABLE_UPDATE_ENDED, vars) + errorCatched(init)
 *   非 MVU 脚本    → 脚本位只放 JS（不许 HTML）、$ 用页面 jQuery、DOM ready、悬浮用 pointer 事件、不碰 window.top.document
 *   世界书条目     → 常驻就别挂 keys、非常驻必须有 keys、position 语义要对、正文不许混 HTML/未闭合宏
 */

const FORBIDDEN_TAGS = ['<khl>', '</khl>', '<thinking>', '</thinking>', '<content>', '</content>'];

const CORE_FN = {
    beautify: ['getMessageData', 'extractContent', 'renderPage', 'init'],
    structured: ['getMessageData', 'parseData', 'renderPage', 'init'],
    chat: ['callParentApi', 'sendMessage', 'renderMessage', 'init'],
};

/** 前端规范（结构化，工具直接返回给模型） */
export const FE_SPEC = {
    kinds: {
        beautify: {
            what: '正文美化：把 AI 正文包进 <任意英文标签>…</标签>，用正则渲染成信纸/日记/对话气泡',
            regex: 'name=[界面]正文美化, find=/<标签>([\\s\\S]*?)<\\/标签>/g, placement=[2], markdownOnly=true, promptOnly=false, runOnEdit=true',
            must_keep: CORE_FN.beautify,
            traps: [
                '标签名不固定：用户指定或按内容命名，findRegex / extractContent 正则 / 正文包裹三处必须同一标签',
                '标签只包正文本身：开场白、备用开场白、<StatusPlaceHolderImpl/> 一律不进标签，否则会把状态栏占位符吞掉',
            ],
        },
        structured: {
            what: '结构化数据面板：AI 按固定格式输出数据（论坛/任务面板/数据卡），正则替换成界面',
            regex: 'name=[界面]页面名称, find=/<标签名>[\\s\\S]*?<\\/标签名>/g, placement=[2], markdownOnly=true, runOnEdit=true',
            must_keep: CORE_FN.structured,
            traps: [
                '独立面板（不是正文美化）用随机英文标记（如 ^DX_SETUP_PANEL_8K9F2A$）当 findRegex，正文只输出这行标记',
                '同时要有一条世界书条目规定 AI 输出格式（含 Format 示例），否则模型不会稳定产出标签块',
            ],
        },
        chat: {
            what: '0 层卡 / 界面内游玩：所有对话只在前端 iframe 内展示，不创建酒馆楼层',
            api: "window.parent.TavernHelper.generate({ should_stream:true, should_return_reasoning:true, disable_extras:true, stop_everything:true })",
            must_keep: CORE_FN.chat,
            traps: [
                '流式监听 STREAM_TOKEN_RECEIVED_FULLY 并按 generation_id 过滤，reasoning 单独交付（{content, reasoning}）',
                '历史只存前端内存 state.messages，不调 createChatMessages；要持久化就写聊天变量 {type:"chat"}',
                'Enter 发送、Shift+Enter 换行；buildPrompt 负责把角色设定 + 历史拼成提示词',
            ],
        },
        floating: {
            what: '悬浮球 / 悬浮前端 —— 这是脚本，不是正则',
            host: "脚本里的 $ 就是酒馆页面 jQuery：$('<style>').appendTo('head')、$('<div>').appendTo('body')",
            traps: [
                '禁止 window.top.document；禁止取不到 top 就回退脚本自己的 document',
                "必须等 DOM ready（$(() => {}) 或 readyState 检查）；$ 缺失用 window.parent.$ / window.jQuery 兜底",
                '简单悬浮用 div + position:fixed；完整前端隔离才 createScriptIdIframe().appendTo("body")',
                '拖拽用 pointerdown + setPointerCapture，move/up 绑父页面 document，位移>4px 才算拖拽，拖拽后吞一次 click',
                '重渲染自愈用 MutationObserver / 低频检查根节点，只在不存在时重建，禁止重复 append',
            ],
        },
    },
    html_rules: [
        '完整 HTML 必须 <!DOCTYPE html> + <style> + <body> + <script>，代码全部内联，样式贴合聊天区宽度',
        '任何完整 HTML 都要 ```html 围栏包裹；禁止裸写在操作块里',
        '严禁 <khl> / <thinking> / <content> 标签名',
        '闭合标签后不再输出别的内容；"{{}}"不是格式的一部分，禁止携带到界面里',
    ],
    slash: [
        '/send (string) 以用户身份发消息（不触发生成）；/trigger 触发生成；范式 triggerSlash("/send "+keyword+"："+param+"|/trigger")',
        '/sys 旁白；/popup /input /buttons 弹窗；/setvar /getvar /addvar 本地变量；/setglobalvar 全局变量',
        '/inject id=唯一ID text 注入提示词；/delay 毫秒；/echo 提示',
    ],
};

/** 状态栏规范（与 mvu.statusbar 的模板一致） */
export const STATUSBAR_SPEC = {
    structure: '完整 HTML 文档：<!doctype html> + <head><style>…</style><script type="module">…</script></head> + <body>',
    entry_point: '$(errorCatched(init)) —— 不要用裸 async IIFE',
    init: [
        "await waitGlobalInitialized('Mvu')",
        "await waitUntil(() => _.has(getVariables({type:'message'}), 'stat_data'))（隔离 iframe 里可能没有这个全局，写卡器会注入幂等兜底，别依赖它的时序）",
        '读变量：getAllVariables() 或 getVariables({type:"message"})，用 _.get(data, "stat_data.路径", 默认值)',
    ],
    refresh: [
        'VARIABLE_UPDATE_ENDED 回调签名是 (new_variables, old_variables)：populateCharacterData(variables) 直接用第一个参数',
        '写成 populateCharacterData(data?.new_variables) 会恒为 undefined —— 这是「状态栏永远读不到变量」的头号原因',
        '不要用 setInterval 轮询',
    ],
    dom: ['每个要显示的变量在 body 里有唯一 id，populateCharacterData 里 $(#id).text(v) 逐格填充', 'getvar 路径必须与 InitVar 的键名逐字一致（含中文与大小写）'],
};

/** 非 MVU 脚本规范 */
export const SCRIPT_SPEC = {
    where: '脚本位只放 JS/JS 模块内容；HTML 属于正则的 replaceString，不属于脚本',
    runtime: [
        '脚本运行在酒馆页面上下文：$ / _ / toastr 可用；完整前端隔离用 createScriptIdIframe()',
        "需要等 MVU 就绪：await waitGlobalInitialized('Mvu')",
        '事件用 eventOn / eventOnce / eventRemoveListener，别自己 setInterval 造轮子',
    ],
    traps: [
        'window.top.document 一律禁止（跨域 + 沙箱会抛 SecurityError）',
        "import { z } from 'zod' 在脚本里会崩：z 在 MVU Zod 环境是全局",
        '脚本里混入 <!DOCTYPE 或 <html 说明放错位置（应该写进正则）',
        '按钮要声明在 script.button.buttons 里并 visible 控制，别靠 UI 层事后补',
    ],
};

/** 世界书条目规范（非 MVU 条目同样适用） */
export const ENTRY_SPEC = {
    position: {
        0: 'before_character_definition —— 世界设定 / 总纲 / 输出格式这类"必须一直在"的内容',
        1: 'after_character_definition —— 人设、地点、势力等背景材料',
        2: 'before_prompt（depth 生效）—— 需要贴近对话末尾注入的提醒/状态栏',
        4: 'at_depth —— 变量规则、变量列表、占位提醒这类每轮都该看的规则',
    },
    constant: '常驻=蓝灯（constant=true, enabled=true）：每轮都进提示词，适合规则/格式；触发式=绿灯（constant=false + keys）：提到才进，适合人设条目',
    keys: [
        'constant=true 的条目不该挂 keys（挂了也不生效，还会让 UI 看着像触发式）',
        'constant=false 且 keys 为空 = 永远不触发，等于白写',
        'keys 用条目名派生：去掉「的/是/我/你/相关/条目/内容/设定」这类虚词，取 2~4 个字的具体词',
    ],
    content: [
        '正文里出现 <% 会被当 EJS 执行：只想放文本就用 <%% 或不写',
        '{{...}} 必须成对闭合；InitVar 这类 YAML 里禁止出现酒馆宏（初始化时会被替换成乱码）',
        '条目正文不放 HTML：HTML 属于正则 replaceString',
    ],
};

const MVU_TEMPLATE_NAMES = /^(世界元数据|状态栏|状态变量输出|统一输出格式|角色边界|禁止项|自定义条目|[\[<]?(InitVar|mvu_update|状态栏)|[\[<]状态栏|变量列表|变量更新|变量输出)/;

/** 找有开无闭的 {{（CSS/JS 的 }} 不算） */
function findUnclosedMacro(text) {
    const lines = [];
    let i = -1;
    while ((i = text.indexOf('{{', i + 1)) >= 0) {
        const close = text.indexOf('}}', i + 2);
        if (close < 0 || close - i > 240) lines.push(text.slice(0, i).split('\n').length - 1);
    }
    return lines;
}

/* ------------------------------ 体检 ------------------------------ */

function hasAll(text, list) {
    return list.filter(fn => text.indexOf(fn) < 0);
}

/** 前端 HTML 体检（kind: beautify / structured / chat / floating） */
export function auditFrontend(html, kind = 'chat') {
    const s = String(html || '');
    const k = String(kind || 'chat').toLowerCase();
    const problems = [];
    const fixes = [];
    const notes = [];

    if (!s.trim()) return { ok: false, problems: ['HTML 是空的'], fixes: ['先按 fe.spec 拿模板再填'], notes: [] };

    for (const tag of FORBIDDEN_TAGS) {
        if (s.toLowerCase().indexOf(tag) >= 0) {
            problems.push(`用了禁用标签 ${tag}`);
            fixes.push('换成语义标签（panel / story / diary / letter 等任意小写英文）');
        }
    }
    if (/window\.top\.document/.test(s)) {
        problems.push('用了 window.top.document：跨域/沙箱会抛 SecurityError');
        fixes.push('脚本里直接用页面 $（$("<div>").appendTo("body")），隔离场景用 createScriptIdIframe()');
    }

    const isDoc = /<!doctype\s/i.test(s) && /<html[\s>]/i.test(s);
    if (!isDoc) {
        problems.push('不是完整 HTML 文档（缺 <!DOCTYPE html> / <html>）');
        fixes.push('按模板补全：<!DOCTYPE html> + <head><style>…</style></head> + <body> + <script>');
    }
    if (/<style/i.test(s) === false) notes.push('没有 <style>：样式会退回酒馆默认，界面会很素');
    if (/<script/i.test(s) === false) notes.push('没有 <script>：纯静态 HTML 可以，但要交互就得补');

    const must = CORE_FN[k] || CORE_FN.chat;
    const missing = hasAll(s, must);
    if (missing.length) {
        problems.push(`核心函数缺失：${missing.join('、')}（${k} 模板要求这些结构不许删）`);
        fixes.push('从 fe.spec 拿对应模板，只改样式/标签名/解析逻辑，别删核心函数');
    }

    if (k === 'chat') {
        const need = ['should_stream', 'disable_extras', 'stop_everything', 'state.messages'];
        const lack = hasAll(s, need);
        if (lack.length) {
            problems.push(`0 层卡关键参数缺失：${lack.join('、')}`);
            fixes.push('callParentApi 必须带 should_stream / disable_extras:true / stop_everything:true，历史只存 state.messages');
        }
        if (!/TavernHelper/.test(s)) { problems.push('没有通过 window.parent.TavernHelper 调模型'); fixes.push('静默生成只能走 window.parent.TavernHelper.generate'); }
        if (!/keydown/.test(s)) notes.push('没看到 keydown 绑定：确认 Enter 发送 / Shift+Enter 换行已实现');
    }
    if (k === 'structured' && !/parseData/.test(s)) {
        problems.push('structured 模板缺 parseData：数据块解析不到就渲染不出内容');
    }
    if (k === 'beautify' && !/extractContent/.test(s)) {
        problems.push('beautify 模板缺 extractContent：正文抽不出来');
    }
    if (k === 'floating') {
        if (!/readyState|\$\(function|\$\(\(\)\s*=>/.test(s)) { problems.push('悬浮脚本没等 DOM ready'); fixes.push("用 $(() => {}) 或 readyState 检查包住 init"); }
        if (!/pointerdown/.test(s) && /drag/i.test(s)) notes.push('拖拽没看到 pointerdown：移动端 touch 事件会丢');
    }
    notes.push(`核心函数检查基于 ${k} 模板；改动样式不会影响这些结构`);

    return { ok: problems.length === 0, kind: k, bytes: s.length, problems, fixes, notes };
}

/** 状态栏 HTML 体检 */
export function auditStatusbar(html, statPaths = []) {
    const s = String(html || '');
    const problems = [];
    const fixes = [];
    const notes = [];
    if (!s.trim()) return { ok: false, problems: ['状态栏 HTML 是空的'], fixes: ['mvu.templates 拿 standard 模板再填 body'], notes: [] };

    const must = ['populateCharacterData', 'errorCatched', 'getAllVariables'];
    const missing = hasAll(s, must);
    if (missing.length) { problems.push(`缺核心结构：${missing.join('、')}`); fixes.push('用 mvu.templates 的 status_bar_standard，保留 populateCharacterData / errorCatched / getAllVariables'); }
    if (!/VARIABLE_UPDATE_ENDED/.test(s)) { problems.push('没监听 VARIABLE_UPDATE_ENDED：变量更新后状态栏不会刷新'); fixes.push('eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, (variables) => populateCharacterData(variables))'); }
    if (/new_variables/.test(s)) { problems.push('出现 data?.new_variables：回调第一个参数就是 MvuData，这么写恒为 undefined'); fixes.push('改成 populateCharacterData(variables)（或直接传第一个参数）'); }
    if (/setInterval/.test(s)) { problems.push('用 setInterval 轮询变量：会一直读旧值且耗性能'); fixes.push('改成事件驱动（VARIABLE_UPDATE_ENDED）'); }
    if (/waitUntil\s*\(/.test(s) && s.indexOf('window.waitUntil') < 0) {
        notes.push('写了 waitUntil：隔离 iframe 里没有这个全局，保存时会被自动注入幂等兜底（mvu.statusbar 已内置）');
    }
    if (!/<!doctype\s/i.test(s)) { problems.push('不是完整 HTML 文档'); fixes.push('补 <!doctype html> + <html> + <head> + <body>'); }

    const refs = [];
    const re = /_.get\(\s*[^,]+,\s*['"]stat_data\.([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(s))) refs.push(m[1]);
    const paths = statPaths.filter(Boolean);
    if (paths.length && refs.length) {
        const missingPaths = refs.filter(p => !paths.includes(p));
        if (missingPaths.length) {
            problems.push(`状态栏引用了不存在的变量路径：${missingPaths.slice(0, 8).join('、')}`);
            fixes.push('把路径改成 InitVar 里真实存在的键（含中文与层级），或先在 InitVar 补上');
        }
    }
    if (!refs.length) notes.push('没解析到 _.get(…, "stat_data.xxx") 的引用：如果变量是从事件参数里取的，忽略这条');

    return { ok: problems.length === 0, bytes: s.length, refs, problems, fixes, notes };
}

/** 非 MVU 脚本体检 */
export function auditScript(content, name = '') {
    const s = String(content || '');
    const problems = [];
    const fixes = [];
    const notes = [];
    if (!s.trim()) return { ok: false, problems: ['脚本内容是空的'], fixes: [], notes: [] };

    if (/<!doctype\s/i.test(s) || /<html[\s>]/i.test(s)) {
        problems.push('脚本里出现完整 HTML 文档：HTML 属于正则 replaceString，不该放脚本位');
        fixes.push('把 HTML 挪进正则（[界面]xxx 的 replaceString），脚本只留逻辑');
    }
    if (/import\s*\{[^}]*\bz\b[^}]*\}\s*from\s*['"]zod['"]/.test(s)) {
        problems.push("脚本里 import { z } from 'zod'：z 在 MVU Zod 环境是全局，裸 import 会崩");
        fixes.push('删掉这行 import，直接用 z');
    }
    if (/window\.top\.document/.test(s)) { problems.push('用了 window.top.document（跨域/沙箱抛错）'); fixes.push('用页面 $ 或 createScriptIdIframe()'); }
    if (/setInterval/.test(s) && !/MutationObserver/.test(s)) notes.push('有 setInterval：确认不是拿轮询代替事件/观察器');
    if (!/^\s*(\/\/|\/\*|import|const|let|var|function|async|class|\$\(|window\.|document\.)/m.test(s) && s.length > 40) {
        notes.push('开头不像 JS（可能是说明文字混进来了）：脚本位只放可执行代码');
    }
    if (/TavernHelper/.test(s) && !/window\.parent\.TavernHelper|TavernHelper\./.test(s)) notes.push('提到 TavernHelper 但没走 window.parent（iframe 内会拿不到）');
    if (/createScriptIdIframe/.test(s)) notes.push('检测到 createScriptIdIframe：完整前端隔离用法正确');
    const hasChars = s.length;
    notes.push(`脚本 ${name ? `「${name}」` : ''}${hasChars} 字符；运行时出错时在酒馆控制台看 [st-agent] 前缀日志`);

    return { ok: problems.length === 0, bytes: s.length, problems, fixes, notes };
}

/** 世界书条目体检（可单条，也可整本） */
export function auditEntryList(entries) {
    const list = (entries || []).map(e => ({
        uid: e.uid,
        comment: e.comment || '',
        content: String(e.content || ''),
        position: Number(e.position === undefined ? 0 : e.position),
        depth: Number(e.depth === undefined ? 4 : e.depth),
        order: Number(e.order === undefined ? 100 : e.order),
        constant: !!e.constant,
        disable: !!e.disable,
        keys: Array.isArray(e.key) ? e.key : (Array.isArray(e.keys) ? e.keys : []),
    }));
    const problems = [];
    const fixes = [];
    const notes = [];
    const nameCount = {};
    for (const e of list) nameCount[e.comment] = (nameCount[e.comment] || 0) + 1;

    for (const e of list) {
        const tag = `「${e.comment || '(无名 ' + e.uid + ')'}」`;
        if (nameCount[e.comment] > 1) { problems.push(`${tag} 重名：同名的多条会互相顶掉`); fixes.push('改名区分（加 [分类] 前缀）'); }
        if (!e.constant && !e.keys.length) {
            if (MVU_TEMPLATE_NAMES.test(e.comment)) {
                notes.push(`${tag} 是 MVU 模板条目（写卡器原样就是 constant=false + keys 空）：靠玩家填触发词或手动改常驻，别当成写坏`);
            } else {
                problems.push(`${tag} 是触发式但没有 keys：永远进不了提示词，等于白写`);
                fixes.push('补 keys（2~4 字具体词），或改成 constant=true 常驻');
            }
        }
        if (e.constant && e.keys.length) {
            notes.push(`${tag} 常驻却挂了 ${e.keys.length} 个 keys：keys 不生效，UI 上容易误读成触发式`);
        }
        if (e.constant && e.disable) {
            if (MVU_TEMPLATE_NAMES.test(e.comment)) {
                notes.push(`${tag} 常驻但 enabled=false：写卡器的 InitVar / 格式强调条目本就不进提示词（只给脚本和变量系统读），正确`);
            } else {
                problems.push(`${tag} 常驻但被禁用：内容完全不会进提示词`);
                fixes.push('把 enabled 改 true，或确认它就是给脚本读的数据条目');
            }
        }
        if (e.position === 2 && e.depth === 0) {
            notes.push(`${tag} position=2 且 depth=0：会紧贴最后一条消息注入，确认这是想要的（变量规则一般用 position=4）`);
        }
        if (/<!doctype\s|<html[\s>]|<script[\s>]/i.test(e.content)) {
            if (/前端|界面|status|状态栏/.test(e.comment) || /^\s*<div|<!doctype/i.test(e.content.slice(0, 60))) {
                notes.push(`${tag} 把整段 HTML 放在条目正文里：写卡器的做法是 HTML 进正则 replaceString，条目只留输出格式说明；正文 HTML 会让每轮提示词多背几万字符`);
            } else {
                problems.push(`${tag} 正文里有 HTML/script：条目正文应是纯文本或 EJS，HTML 该放正则`);
                fixes.push('把 HTML 挪到正则 replaceString');
            }
        }
        if (/<%/.test(e.content) && !/<%[_=-]?>?/.test(e.content)) {
            notes.push(`${tag} 含 <%：会被当 EJS 执行，确认是有意为之`);
        }
        const unclosed = findUnclosedMacro(e.content);
        if (unclosed.length) {
            problems.push(`${tag} 有 ${unclosed.length} 处 {{ 没闭合（第 ${unclosed.map(n => n + 1).join('、')} 行）：会原样漏进提示词`);
            fixes.push('补上对应的 }}；CSS/JS 里的 }} 不算宏闭合，别被它误导');
        }
    }
    if (!list.length) problems.push('这个世界里一条条目都没有');

    return { ok: problems.length === 0, total: list.length, problems, fixes, notes };
}
