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

/**
 * 世界书条目规范（ST 1.19.1 world-info.js 口径；非 MVU 条目同样适用）
 * 全部取值/默认值来自 newWorldInfoEntryDefinition(4082)、world_info_position、world_info_logic。
 */
export const ENTRY_SPEC = {
    source: 'SillyTavern 1.19.1 · public/scripts/world-info.js',
    position: {
        0: 'before —— 角色定义之前：世界设定 / 总纲 / 输出格式这类"必须一直在"的内容',
        1: 'after —— 角色定义之后：人设、地点、势力等背景材料',
        2: 'ANTop —— 作者注释顶部：贴在最靠近对话的提示区头部',
        3: 'ANBottom —— 作者注释底部：比 ANTop 更贴近对话（写卡器没有用过这个位置）',
        4: 'atDepth —— 按 depth + role 插进对话流：变量规则 / 变量列表 / 占位提醒这类每轮都要看的规则',
        5: 'EMTop —— 范例消息顶部（有 mes_example 时才看得到）',
        6: 'EMBottom —— 范例消息底部',
        7: 'outlet —— 具名插座：必须同时给 outletName，否则这条被跳过并告警',
    },
    order: [
        'order 只在同一个 position 段内比先后，跨段无效（before 段整体仍在角色定义前）',
        '源码是 sortFn=(a,b)=>b.order-a.order 降序再逐条 unshift，所以成品提示词里 order 小的在前、大的在后',
        '也就是说：想让某条更靠近对话末端、被模型更重视，把 order 调大；UI 列表里 order 大的显示在上，别被界面骗',
        '同段 order 相同 = 顺序不确定（取决于数组序），规则/格式条目要显式给不同 order',
    ],
    constant: '常驻=true：不进关键词判定，每轮都进提示词（规则/格式/元数据用它）；触发式=false：必须给 keys，提到才进（人设/地点条目用它）。constant=false + keys 空 = 永远不激活',
    keys: [
        'constant=true 的条目不该挂 keys（挂了也不生效，还会让 UI 看着像触发式）',
        'constant=false 且 keys 为空 = 永远不触发，等于白写',
        'key 可以写 /pattern/flags 直接用正则 test，此时大小写/整词设置全部被忽略',
        '正则 key 必须写成 /…/flags 且内部不能出现未转义的 /，flags 仅 gimsuy',
        'matchWholeWords 对中文基本无效（ST 按空格拆词，再用 (?:^|\W)(key)(?:$|\W) 包裹）；中文防误触发要靠更长的复合词',
        'keys 用条目名派生：去掉「的/是/我/你/相关/条目/内容/设定」这类虚词，取 2~4 个字的具体词',
    ],
    selective: [
        'selective=true 且 keysecondary 非空：主键命中后再按 selectiveLogic 判副键',
        'selective=false 或 keysecondary 为空：副键完全不参与，填了也白填',
        'selectiveLogic：0=AND_ANY（任一命中）1=NOT_ALL（任一不命中）2=NOT_ANY（全部不命中）3=AND_ALL（全部命中）',
    ],
    defaults: {
        constant: false, selective: true, selectiveLogic: 0, order: 100, position: 0,
        depth: 4, role: 0, probability: 100, useProbability: true, groupWeight: 100,
        scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
        sticky: null, cooldown: null, delay: null, delayUntilRecursion: 0, ignoreBudget: false,
        excludeRecursion: false, preventRecursion: false, triggers: [],
    },
    overrides: [
        'scanDepth / caseSensitive / matchWholeWords / useGroupScoring 为 null 时继承全局；给数字/布尔就覆盖全局',
        '全局默认：scanDepth=2 条消息、budget=25% 上下文、caseSensitive=false、matchWholeWords=false、recursive=false、min_activations=0',
        'sticky=N 激活后保持 N 条；cooldown=N sticky 结束后 N 条内不再激活；delay=N 最近 N 条内不激活',
        'delayUntilRecursion=N 只在第 N 层递归扫描时才有资格；excludeRecursion=true 递归轮不再激活；preventRecursion=true 激活后不把自己的内容送进递归扫描',
        'probability=N 且 useProbability=true 时按 N% 掷骰；没通过当轮直接放弃、后续轮次也不再考虑（sticky 条目免掷）',
    ],
    groups: [
        'group 可用逗号声明多个互斥组；组内先按 sticky 定胜负，再看是否已有成员激活',
        'groupOverride=true：组内 order 最大的直接赢，其余删除',
        '没有 groupOverride：按 groupWeight（默认 100）加权随机抽一个',
        'useGroupScoring=true 或全局开组评分：先按主/副关键词命中数评分，低于组内最高分的被淘汰（可并列保留）',
    ],
    budget: [
        'budget = round(25% × 上下文)，被 budget_cap 截断；超预算的条目自己就被丢弃（不是先收下再截断）',
        'ignoreBudget=true：不受预算限制，会继续插进提示词并挤占后面的条目',
    ],
    decorators: [
        '正文里的 @@activate / @@dont_activate 会被 parseDecorators 剥掉并直接强制/禁止激活；这两个标记不会进提示词',
    ],
    card_format: [
        '卡内 character_book 的 V2 字段：keys / secondary_keys / insertion_order / enabled / constant / selective / content / comment',
        'constant、selective、insertion_order、enabled 看顶层；position 优先 extensions.position（数字 0–7），顶层 before_char/after_char 只是回退',
        '程序写卡建议双写：内部字段 + extensions 的 snake_case 键，别只写一边',
    ],
    content: [
        'ST 不执行 EJS：条目正文里的 <% %> 不会运行，只会原样进提示词（酒馆助手的渲染链另说）；纯文本条目别写',
        '{{...}} 宏会执行（content 在激活阶段就 substituteParams，key 也会），所以 InitVar 这类 YAML 里不能出现酒馆宏',
        '条目正文不放 HTML：HTML 属于正则 replaceString',
        '正文会被 placement=5(WORLD_INFO) 的正则再处理一遍，promptOnly 规则太宽会把正文洗成空串导致整条被丢弃',
    ],
};

const MVU_TEMPLATE_NAMES = /^(世界元数据|状态栏|状态变量输出|统一输出格式|角色边界|禁止项|自定义条目|[\[<]?(InitVar|mvu_update|状态栏)|[\[<]状态栏|变量列表|变量更新|变量输出)/;

/**
 * MVU 模板条目的期望 constant（写卡器 ENTRY_TEMPLATES 的原值）。
 * 用途：不是「模板名一律豁免」，而是「按模板比对」——规则类写成触发式要报 problem。
 * 0 = 写卡器本来就不让它激活（状态栏/状态变量输出/自定义条目 由正则或玩家接管）。
 */
const MVU_EXPECT_CONSTANT = [
    [/世界元数据/, 1], [/统一输出格式/, 1], [/角色边界/, 1], [/禁止项/, 1],
    [/变量列表/, 1], [/变量更新规则/, 1], [/变量输出格式强调/, 1], [/变量输出格式/, 1],
    [/InitVar|初始变量/, 1], [/占位符提醒/, 1],
    [/^状态栏$|「?状态栏」?$/, 0], [/状态变量输出/, 0], [/自定义条目/, 0],
];
function expectConstant(comment) {
    for (const [re, v] of MVU_EXPECT_CONSTANT) if (re.test(String(comment || ''))) return v;
    return null;
}

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

    // 去注释后再查代码特征，避免注释里写「不要用 window.top.document」被误判
    const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
    const htmlDoc = /<!doctype\s/i.test(code) || /<html[\s>]/i.test(code);
    if (htmlDoc && !/contentDocument|srcdoc|createScriptIdIframe/.test(code)) {
        problems.push('脚本里出现完整 HTML 文档：HTML 属于正则 replaceString，不该放脚本位');
        fixes.push('把 HTML 挪进正则（[界面]xxx 的 replaceString），脚本只留逻辑');
    } else if (htmlDoc) {
        notes.push('脚本内嵌了 HTML 文档：只在 iframe（contentDocument/srcdoc）里渲染是合法的，不要塞父页面 DOM');
    }
    if (/import\s*\{[^}]*\bz\b[^}]*\}\s*from\s*['"]zod['"]/.test(s)) {
        problems.push("脚本里 import { z } from 'zod'：z 在 MVU Zod 环境是全局，裸 import 会崩");
        fixes.push('删掉这行 import，直接用 z');
    }
    if (/window\.top\.document/.test(code)) { problems.push('用了 window.top.document（跨域/沙箱抛错）'); fixes.push('用页面 $ 或 createScriptIdIframe()'); }
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

/** 引擎合法的触发器取值（constants.js GENERATION_TYPE_TRIGGERS） */
const WI_TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];
const WI_LOGIC = { 0: 'AND_ANY（任一命中）', 1: 'NOT_ALL（任一不命中）', 2: 'NOT_ANY（全部不命中）', 3: 'AND_ALL（全部命中）' };
const KEY_REGEX = /^\/([\s\S]+?)\/([gimsuy]*)$/;

/** normalizeEntry：把「内部字段」与「卡内 V2 字段」统一成一份可判定的结构 */
function normEntry(e) {
    const ext = (e && e.extensions) || {};
    const pick = (...vals) => { for (const v of vals) if (v !== undefined && v !== null) return v; return undefined; };
    const rawPos = pick(e.position, ext.position);
    let position = 0;
    if (typeof rawPos === 'number') position = rawPos;
    else if (typeof rawPos === 'string') position = rawPos === 'after_char' || rawPos === 'after' ? 1 : 0;
    const keys = Array.isArray(e.key) ? e.key : (Array.isArray(e.keys) ? e.keys : []);
    const secondary = Array.isArray(e.keysecondary) ? e.keysecondary : (Array.isArray(e.secondary_keys) ? e.secondary_keys : []);
    const enabled = e.disable === true ? false : (e.enabled === false ? false : true);
    return {
        uid: e.uid,
        comment: String(e.comment || ''),
        content: String(e.content || ''),
        position,
        depth: Number(pick(e.depth, ext.depth, 4)),
        role: Number(pick(e.role, ext.role, 0)),
        order: Number(pick(e.order, e.insertion_order, 100)),
        constant: pick(e.constant, ext.constant, false) === true,
        selective: pick(e.selective, ext.selective, true) === true,
        selectiveLogic: Number(pick(e.selectiveLogic, ext.selectiveLogic, 0)),
        keys,
        secondary,
        enabled,
        probability: Number(pick(e.probability, ext.probability, 100)),
        useProbability: pick(e.useProbability, ext.useProbability, true) !== false,
        sticky: pick(e.sticky, ext.sticky),
        cooldown: pick(e.cooldown, ext.cooldown),
        delay: pick(e.delay, ext.delay),
        group: String(pick(e.group, ext.group, '') || ''),
        groupWeight: Number(pick(e.groupWeight, ext.group_weight, 100)),
        groupOverride: pick(e.groupOverride, ext.group_override, false) === true,
        useGroupScoring: pick(e.useGroupScoring, ext.use_group_scoring),
        scanDepth: pick(e.scanDepth, ext.scan_depth),
        caseSensitive: pick(e.caseSensitive, ext.case_sensitive),
        matchWholeWords: pick(e.matchWholeWords, ext.match_whole_words),
        ignoreBudget: pick(e.ignoreBudget, ext.ignore_budget, false) === true,
        triggers: Array.isArray(pick(e.triggers, ext.triggers, [])) ? pick(e.triggers, ext.triggers, []) : [],
        outletName: String(pick(e.outletName, ext.outlet_name, '') || ''),
        hasCharFilter: !!(e.characterFilter && (Array.isArray(e.characterFilter.names) || Array.isArray(e.characterFilter.tags))),
    };
}

/** 关键词是不是合法的 /pattern/flags 正则（ST 要求整串匹配 + 内部斜杠必须转义） */
function keyCheck(k) {
    const str = String(k || '');
    if (str.indexOf('/') < 0) return { regex: false };
    const m = str.match(KEY_REGEX);
    if (!m) return { regex: true, ok: false, why: '不是 /pattern/flags 形式（结尾缺 /flags）' };
    if (/(^|[^\\])\//.test(m[1])) return { regex: true, ok: false, why: '模式里有未转义的 /（请写成 \\/' };
    return { regex: true, ok: true };
}

/** 时间效果字段：null=关，否则必须非负整数 */
function effectBad(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return `=${JSON.stringify(v)} 不是非负数字`;
    return null;
}

/** 世界书条目体检（可单条，也可整本；ST 1.19.1 全字段口径） */
export function auditEntryList(entries, opts = {}) {
    const list = (entries || []).map(normEntry);
    const problems = [];
    const fixes = [];
    const notes = [];
    const nameCount = {};
    for (const e of list) nameCount[e.comment] = (nameCount[e.comment] || 0) + 1;

    for (const e of list) {
        const tag = `「${e.comment || '(无名 ' + e.uid + ')'}」`;
        if (nameCount[e.comment] > 1) { problems.push(`${tag} 重名：同名的多条会互相顶掉`); fixes.push('改名区分（加 [分类] 前缀）'); }

        // ① 激活能力：能不能真的进提示词（模板条目按写卡器原值比对，不是一律豁免）
        const expectC = expectConstant(e.comment);
        if (expectC === 0) {
            if (e.constant) notes.push(`${tag} 写卡器模板里这条本来不激活（靠正则/玩家接管），现在被设成常驻：会白白占提示词预算`);
        } else if (expectC === 1 && !e.constant) {
            problems.push(`${tag} 按写卡器模板应当是 constant=true（常驻），现在 constant=false：${e.keys.length ? '靠关键词触发，模型经常看不到' : '而且 keys 为空，这条永远不激活'}`);
            fixes.push(`把「${e.comment}」改成 constant=true、selective=false（写卡器 ENTRY_TEMPLATES 原值）`);
        } else if (!e.constant && !e.keys.length) {
            if (MVU_TEMPLATE_NAMES.test(e.comment)) {
                notes.push(`${tag} 是 MVU 模板条目（写卡器原样就是 constant=false + keys 空）：靠玩家填触发词或手动改常驻，别当成写坏`);
            } else {
                problems.push(`${tag} 是触发式但没有 keys：永远进不了提示词，等于白写`);
                fixes.push('补 keys（2~4 字具体词），或改成 constant=true 常驻');
            }
        }
        if (e.constant && e.keys.length) notes.push(`${tag} 常驻却挂了 ${e.keys.length} 个 keys：keys 不生效，UI 上容易误读成触发式`);
        if (e.constant && !e.enabled) {
            if (MVU_TEMPLATE_NAMES.test(e.comment)) notes.push(`${tag} 常驻但 enabled=false：写卡器的 InitVar / 格式强调条目本就不进提示词（只给脚本和变量系统读），正确`);
            else { problems.push(`${tag} 常驻但被禁用：内容完全不会进提示词`); fixes.push('把 enabled 改 true，或确认它就是给脚本读的数据条目'); }
        }

        // ② 位置 / 深度 / 顺序
        if (!Number.isInteger(e.position) || e.position < 0 || e.position > 7) {
            problems.push(`${tag} position=${e.position} 不是合法落点（只有 0–7）`);
            fixes.push('0 before / 1 after / 2 ANTop / 3 ANBottom / 4 atDepth / 5 EMTop / 6 EMBottom / 7 outlet');
        }
        if (e.position === 7 && !e.outletName) {
            problems.push(`${tag} position=7(outlet) 但没写 outletName：引擎会跳过这条并只在控制台告警`);
            fixes.push('补 outletName，或把 position 改成 4(atDepth)');
        }
        if (e.position === 4) {
            // 写卡器模板条目（更新规则/输出格式/占位提醒）原样就是 p4/d0，不必逐条提示
            if (e.depth === 0 && !MVU_TEMPLATE_NAMES.test(e.comment)) notes.push(`${tag} position=4 且 depth=0：紧贴最后一条消息注入，确认这是想要的（规则类一般 depth=0~2）`);
            if (e.depth > 100) notes.push(`${tag} depth=${e.depth} 过大：超出聊天长度后这条实际不会出现在提示词里`);
        }
        if (/变量更新规则|变量输出格式|统一输出格式|角色边界|禁止项|世界元数据/.test(e.comment) && e.order === 100) {
            notes.push(`${tag} 是规则类条目却用默认 order=100：同段内会被同 position 的其他条目压序，建议显式给 order（写卡器给 200~240）`);
        }

        // ③ 关键词与副键
        const badKeys = e.keys.map(keyCheck).filter(k => k.regex && !k.ok);
        if (badKeys.length) {
            problems.push(`${tag} 有 ${badKeys.length} 个 key 写成了正则但格式非法（${badKeys[0].why}）：这条永远匹配不上`);
            fixes.push('改成 /pattern/flags（内部斜杠写 \\/，flags 只 gimsuy），或写成普通关键词');
        }
        if (!Number.isInteger(e.selectiveLogic) || e.selectiveLogic < 0 || e.selectiveLogic > 3) {
            problems.push(`${tag} selectiveLogic=${e.selectiveLogic} 非法（只有 0–3）`);
            fixes.push('0 AND_ANY / 1 NOT_ALL / 2 NOT_ANY / 3 AND_ALL');
        }
        if (!e.selective && e.secondary.length) {
            notes.push(`${tag} selective=false 却填了 ${e.secondary.length} 个副键：副键完全不参与判定（填了等于没填）`);
        }
        if (e.selective && e.keys.length && !e.secondary.length) {
            notes.push(`${tag} selective=true 但副键为空：等同普通单关键词触发，不算错`);
        }
        if (e.selective && e.secondary.length && e.selectiveLogic === 1) {
            notes.push(`${tag} 用了 NOT_ALL（1）：副键「有一个没命中」就激活，最容易莫名触发，确认是这个意图`);
        }
        if (e.matchWholeWords === true && e.keys.length && e.keys.every(k => /^[\u4e00-\u9fa5]+$/.test(String(k)))) {
            notes.push(`${tag} 开了 matchWholeWords 但 keys 全是中文：ST 按空格拆词，中文整词匹配基本不生效（想防误触发就加长关键词）`);
        }

        // ④ 概率 / 时间效果 / 分组 / 预算
        if (!Number.isFinite(e.probability) || e.probability < 0 || e.probability > 100) {
            problems.push(`${tag} probability=${e.probability} 越界（0–100）`);
            fixes.push('改成 0–100；想每轮必进就 useProbability=false 或 probability=100');
        } else if (e.useProbability && e.probability < 100 && e.sticky === null) {
            notes.push(`${tag} 只有 ${e.probability}% 概率激活且没有 sticky：没掷中会当轮直接放弃、之后也不再考虑，表现成「有时出现有时不出现」`);
        }
        for (const [name, v] of [['sticky', e.sticky], ['cooldown', e.cooldown], ['delay', e.delay]]) {
            const why = effectBad(v);
            if (why) { problems.push(`${tag} ${name}${why}`); fixes.push(`${name} 要么留空，要么写非负整数（条数）`); }
        }
        if (e.group && (!Number.isFinite(e.groupWeight) || e.groupWeight <= 0)) {
            problems.push(`${tag} 在互斥组「${e.group}」里但 groupWeight=${e.groupWeight}：加权随机抽不到它`);
            fixes.push('groupWeight 给正数（默认 100）');
        }
        if (e.groupOverride && !e.group) notes.push(`${tag} groupOverride=true 但没填 group：这个开关不起作用`);
        if (e.group && e.useGroupScoring === null) notes.push(`${tag} 在互斥组里：要按关键词命中数选优，得开 useGroupScoring 或全局组评分`);
        if (e.ignoreBudget) notes.push(`${tag} ignoreBudget=true：不受 25% 预算限制，会把后面的条目挤出去，确认是给高频规则用的`);

        // ⑤ 触发类型 / 角色过滤
        const badTriggers = e.triggers.filter(t => WI_TRIGGERS.indexOf(String(t)) < 0);
        if (badTriggers.length) {
            problems.push(`${tag} triggers 含未知取值 ${badTriggers.map(String).join('、')}（合法：${WI_TRIGGERS.join('/')}）`);
            fixes.push('删掉未知值，只留 normal/continue/impersonate/swipe/regenerate/quiet');
        }
        if (e.hasCharFilter) notes.push(`${tag} 带 characterFilter：只在指定角色/标签下激活，换角色试玩会「看不到这条」，别误判成写坏`);

        // ⑥ 正文质量（沿用写卡器口径）
        if (/<!doctype\s|<html[\s>]|<script[\s>]/i.test(e.content)) {
            if (/前端|界面|status|状态栏/.test(e.comment) || /^\s*<div|<!doctype/i.test(e.content.slice(0, 60))) {
                notes.push(`${tag} 把整段 HTML 放在条目正文里：写卡器的做法是 HTML 进正则 replaceString，条目只留输出格式说明；正文 HTML 会让每轮提示词多背几万字符`);
            } else {
                problems.push(`${tag} 正文里有 HTML/script：条目正文应是纯文本，HTML 该放正则`);
                fixes.push('把 HTML 挪到正则 replaceString');
            }
        }
        if (/<%[\s\S]*?%>/.test(e.content)) {
            notes.push(`${tag} 正文含 <% %>：ST 不执行 EJS，这段会原样进提示词（只有酒馆助手的渲染链会处理）`);
        }
        if (/@@(activate|dont_activate)/.test(e.content)) {
            notes.push(`${tag} 正文含 @@activate/@@dont_activate：会被剥掉并强制/禁止激活，模型看不到这两个标记`);
        }
        const unclosed = findUnclosedMacro(e.content);
        if (unclosed.length) {
            problems.push(`${tag} 有 ${unclosed.length} 处 {{ 没闭合（第 ${unclosed.map(n => n + 1).join('、')} 行）：会原样漏进提示词`);
            fixes.push('补上对应的 }}；CSS/JS 里的 }} 不算宏闭合，别被它误导');
        }
    }

    // ⑦ 整本聚合
    if (!list.length) problems.push('这个世界里一条条目都没有');
    else {
        const consts = list.filter(e => e.constant && e.enabled);
        const mvuish = list.filter(e => MVU_TEMPLATE_NAMES.test(e.comment));
        if (!consts.length && mvuish.length) {
            problems.push('整本没有一条「常驻且启用」的条目：规则/输出格式类内容一条都进不了提示词（写卡器每张卡至少 3 条常驻）');
            fixes.push('把规则类条目改成 constant=true / enabled=true；触发式只留人设、地点这类按需条目');
        } else if (!consts.length) {
            notes.push('整本都是触发式条目：纯设定书可以，但要有总纲/规则就至少留一条常驻');
        }
        const posCount = {};
        for (const e of list) posCount[e.position] = (posCount[e.position] || 0) + 1;
        notes.push(`position 分布：${Object.entries(posCount).map(([k, v]) => k + '×' + v).join('，')}（规则类走 4，设定走 0/1）`);
    }

    return { ok: problems.length === 0, total: list.length, spec: 'ST 1.19.1', problems, fixes, notes };
}

/* ------------------------------ 正则单条体检 ------------------------------ */

/** 引擎 placement 合法值（4 为 legacy sendAs，0 为已废弃 MD_DISPLAY） */
const PLACEMENTS = { 1: 'USER_INPUT', 2: 'AI_OUTPUT', 3: 'SLASH_COMMAND', 5: 'WORLD_INFO', 6: 'REASONING' };

/**
 * 单条正则体检（ST 1.19.1 regex/engine.js 口径）
 * 覆盖：findRegex 必须 /…/flags 且带 g、placement 必须是数字数组且在 1–6、markdownOnly/promptOnly 互斥、
 * replaceString 里 EJS 不执行、minDepth/maxDepth 语义、trimStrings 类型、substituteRegex 取值。
 */
export function auditRegexScript(r) {
    const s = r || {};
    const problems = [];
    const fixes = [];
    const notes = [];
    const name = `「${s.scriptName || s.name || s.id || '(无名)'}」`;
    const find = String(s.findRegex || '');
    if (!find) {
        problems.push(`${name} 没有 findRegex：这条永远不执行`);
        fixes.push('补 /pattern/flags');
    } else {
        const m = find.match(KEY_REGEX);
        if (m) {
            if (!/[g]/.test(m[2])) {
                problems.push(`${name} flags 里没有 g：ST 用 String.replace，没有 g 只替换第一处，多处匹配的地方只改一个，看起来「时灵时不灵」`);
                fixes.push('把 flags 改成 g 或 gi / gs');
            }
        } else {
            // 非字面量写法也合法：regexFromString 会把它当纯 pattern 编译，但拿不到任何 flags
            notes.push(`${name} findRegex 没包成 /pattern/flags（ST 会当纯 pattern 编译、拿不到 flags）：同一标记在一段文本里出现多次时只替换第一处；需要 g 或大小写控制就写成 /pattern/g`);
        }
    }
    const pl = Array.isArray(s.placement) ? s.placement.map(Number) : null;
    if (!pl) {
        problems.push(`${name} placement 不是数组：引擎用 placement.includes() 判定，字符串/数字永远不命中`);
        fixes.push('写成数字数组，如 [2]（AI 输出）/ [1]（用户输入）/ [2,1]（两者都管）');
    } else {
        if (!pl.length) { problems.push(`${name} placement 是空数组：任何场景都不命中`); fixes.push('至少给 [2]'); }
        const bad = pl.filter(n => !Number.isInteger(n) || n < 0 || n > 6 || n === 4 || n === 0);
        if (bad.length) {
            problems.push(`${name} placement 含非法值 ${bad.join('、')}：合法只有 ${Object.keys(PLACEMENTS).join('/')}（0 已废弃、4 是遗留 sendAs）`);
            fixes.push('AI 自回复用 2，用户输入用 1，世界书正文用 5，推理用 6');
        }
    }
    if (s.markdownOnly === true && s.promptOnly === true) {
        problems.push(`${name} markdownOnly 和 promptOnly 同时为 true：两个分支都会命中，等于在「显示」和「发送」各跑一遍，容易重复替换/自激`);
        fixes.push('只保留一个；要同时改显示和发送，就不勾任何一个（走「改源头」分支）');
    }
    if (/<%[\s\S]*?%>/.test(String(s.replaceString || ''))) {
        problems.push(`${name} replaceString 里有 <% %>：正则替换不执行 EJS，玩家会看到源码`);
        fixes.push('换成可执行 JS（```html 围栏里的 <script>）或纯文本');
    }
    const minD = s.minDepth;
    if (minD !== null && minD !== undefined && minD !== '' && !Number.isFinite(Number(minD))) {
        problems.push(`${name} minDepth=${minD} 不是数字`);
        fixes.push('留空或写整数（-1 表示不限）');
    } else if (Number(minD) === 0) {
        // MVU 六条固定正则本来就该作用于最新楼层（状态栏/思维链/变量美化），不逐条提示
        if (!/^\[美化\]MVU状态栏|^\[不发送\]隐藏状态栏标记|^仅格式思维链|^只发送最新|^\[美化\]变量/.test(String(s.scriptName || '')))
            notes.push(`${name} minDepth=0：最新一条消息的 depth 就是 0，等于没保护最新层；要挡住最新一条得写 1`);
    }
    const maxD = s.maxDepth;
    if (maxD !== null && maxD !== undefined && maxD !== '' && !Number.isFinite(Number(maxD))) {
        problems.push(`${name} maxDepth=${maxD} 不是数字`);
        fixes.push('留空或写非负整数（0 表示只作用于最新一条）');
    }
    if (s.trimStrings !== undefined && s.trimStrings !== null && !Array.isArray(s.trimStrings)) {
        problems.push(`${name} trimStrings 不是数组：引擎会按数组遍历，非数组会抛错`);
        fixes.push('改成 [] 或字符串数组');
    }
    const sub = s.substituteRegex;
    if (sub === undefined || sub === null) {
        notes.push(`${name} 没写 substituteRegex 字段：ST 会取默认 2（每次替换前跑一遍 {{宏}} 替换），写卡器 _convertRegexScript 统一写 0`);
        fixes.push('补 substituteRegex: 0（findRegex 里没有酒馆宏时不需要替换）');
    } else if ([0, 1, 2].indexOf(Number(sub)) < 0) {
        notes.push(`${name} substituteRegex=${sub} 不是 0/1/2：引擎会按「未知值用原始正则」处理`);
    }
    if (s.trimStrings === undefined || s.trimStrings === null) {
        notes.push(`${name} 没有 trimStrings 字段：引擎按数组遍历，缺字段读成 null 时 $1 捕获组不会裁首尾空白`);
        fixes.push('补 trimStrings: []');
    }
    if (s.disabled === true) notes.push(`${name} 是 disabled 状态：这条现在完全不跑（UI 里能看到，引擎会跳过）`);
    return { ok: problems.length === 0, name: s.scriptName || s.name || s.id || '', problems, fixes, notes };
}
