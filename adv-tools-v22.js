/**
 * MVU 变量系统 + EJS 多阶段人设：生成器与审计工具（v1.14）
 *
 * 设计来源：写卡器 v329.59 的 MVU 双引擎与 EJS 实战指南。
 * 核心思路是"模板下沉、AI 只创作内容"：
 *   · MVU 的 6 条固定模板（更新规则 / 输出格式 / 格式强调 / 变量列表 / 占位提醒 / InitVar 框架）
 *     不让模型手写，否则每次写法都不一样、字段名错、position 错，变量系统直接不生效；
 *   · EJS 控制器代码由工具按条件表编译，模型只负责"每档正文到底差在哪"；
 *   · 落盘前统一剥掉 <#escape-ejs> 外层（那只是交付时防执行用的）。
 */

import { loadBook, setEntry, getEntries, entryFields } from './adv-lib-world.js';
import { c } from './adv-lib-core.js';
import { toPlacement } from './tools-set-c.js';
import { charBy, scopedScripts, upsertScoped, allRegexes, scopedAllowed } from './adv-lib-regex.js';
import { writeCardExtensions } from './adv-lib-card.js';
import { fixedMvuRegexes, wrapHtml, unwrapHtml, buildSchemaScript, MVU_RUNTIME_ID, MVU_SCHEMA_ID, FIXED_MVU_REGEX_IDS } from './adv-lib-mvu-assets.js';
import { normalizeEntryComment, entryTemplate, normalizeEntryContent, wcInitVarYaml, wcVarUpdateRule, wcVarOutputFormat, wcVarOutputEmphasis, wcStatusPlaceholder, wcVarListContent } from './adv-lib-wc-entries.js';
import { WC_STATUS_TEMPLATE, mockScript, ensureHtmlDoc, injectMock, parseInitVarYaml } from './adv-lib-mvu-preview.js';
import { FE_CHAT_BASE_HTML, feChatHtml } from './adv-lib-fe-template.js';
import { listSpill, readSpill, setTodos, listSessionsBrief, snapshotSession, usageOf } from './index-sessions.js';
import { getGoal, changeGoal } from './index-goal.js';

/* ------------------------------ 固定模板 ------------------------------ */

const VAR_LIST = '---\n<status_current_variable>\n{{format_message_variable::stat_data}}\n</status_current_variable>';

const PLACEHOLDER = '---\n状态栏占位提醒:\n  rule: 每次回复的最末尾（正文与 <UpdateVariable> 变量更新块之后），必须单独输出一行状态栏占位符，不得省略、不得改写\n  format: <StatusPlaceHolderImpl/>';

const OUTPUT_FORMAT = [
    '---',
    '变量输出格式:',
    '  rule:',
    '    - 你必须在下次回复正文的末尾同时输出「更新分析」和「实际更新命令」',
    '    - 所有变量内容只能根据 <变量更新规则> 计算并更新',
    '    - 更新命令必须遵循 JSON Patch (RFC 6902) 标准，是一个合法的 JSON 数组，仅支持以下操作：',
    '      - replace: 替换已存在路径的值（用于字符串、布尔、枚举，或设置绝对数值）',
    '      - delta: 按增减值更新已存在的数值路径（value 为变动值，不是最终值）',
    '      - insert: 向对象或数组插入新项（对象用于创建新属性；数组用 `-` 表示追加到末尾）',
    '      - remove: 删除已存在的路径',
    '      - move: 移动现有值（from → to）',
    '    - 数值增减必须用 delta；设置绝对新值必须用 replace；insert 只能用于新属性/新元素',
    '    - 不要更新以 `_` 开头的字段（只读变量，AI 可见不可更新，例如 `_关系阶段`）',
    '    - 不要更新以 `$` 开头的字段（派生显示字段，AI 不可见，由脚本/EJS 维护，例如 `$成就`）',
    '    - 更新前必须做历史去重：先前消息里已经反映过的变化不得重复更新，只依据本次回复中的新事件',
    '  format: |-',
    '    <UpdateVariable>',
    '    <Analysis>（用中文，不超过80字，按要点简写）',
    '    - ${计算经过的时间：...}',
    '    - ${是否允许剧情重大变化：是/否}',
    '    - ${历史查重：列出先前消息中已反映变量变化的事件；若无则写"无"}',
    '    - ${仅依据本次回复，结合每个变量对应的 check 逐一分析：...}',
    '    - ${逐项列出变化：当前值 → 新值，或 当前值 + delta → 新值}',
    '    </Analysis>',
    '    <JSONPatch>',
    '    [',
    '      { "op": "replace", "path": "${/到/已存在/变量/的路径}", "value": "${新值}" },',
    '      { "op": "delta", "path": "${/到/数值/变量/的路径}", "value": "${正或负的变动值}" },',
    '      { "op": "insert", "path": "${/到/对象/的新键}", "value": "${新值}" },',
    '      { "op": "insert", "path": "${/到/数组/-}", "value": "${新值}" },',
    '      { "op": "remove", "path": "${/到/对象/的键}" },',
    '      { "op": "move", "from": "${/到/变量/的路径}", "to": "${/到/另/一/路径}" }',
    '    ]',
    '    </JSONPatch>',
    '    </UpdateVariable>',
].join('\n');

const OUTPUT_EMPHASIS = [
    '---',
    '变量输出格式强调:',
    '  rule: 以下内容必须插入到正文末尾，不可省略',
    '  format: |-',
    '    <UpdateVariable>',
    '    ...',
    '    </UpdateVariable>',
].join('\n');

/** 初始变量 YAML：结构骨架 + 中性值（数字 0、布尔 false、字符串占位、对象 {}） */
function initVarYaml(chars) {
    const list = Array.isArray(chars) && chars.length ? chars : ['角色'];
    const lines = [];
    for (const name of list) {
        lines.push(name + ':');
        lines.push('  好感度: 0');
        lines.push('  心情: 平静');
        lines.push('  物品: []');
        lines.push('  衣着:');
        lines.push('    上衣: 未知');
        lines.push('    下装: 未知');
        lines.push('  _关系阶段: 泛泛之交');
        lines.push('  _头像字: ' + String(name).slice(0, 1));
    }
    if (!list.includes('主角')) {
        lines.push('主角:');
        lines.push('  好感度: 0');
        lines.push('  心情: 平静');
        lines.push('  物品: []');
    }
    lines.push('世界:');
    lines.push('  日期: 2026-11-27');
    lines.push('  时间: 09:00');
    lines.push('  天气: 晴');
    lines.push('$成就:');
    lines.push('  初识: false');
    return lines.join('\n');
}

/** 变量更新规则：按 schema 给出 type / range / check（不用 TS interface） */
function updateRuleYaml(chars) {
    const first = (Array.isArray(chars) && chars[0]) || '角色';
    return [
        '---',
        '变量更新规则:',
        '  世界:',
        '    当前时间:',
        '      format: YYYY年MM月DD日 星期X HH:MM',
        '      check:',
        '        - 剧情时间推进、跨日、跨场景时更新',
        '    当前地点:',
        '      check:',
        '        - 角色移动 / 场景切换时更新',
        '    天气:',
        "      type: '晴' | '多云' | '雨' | '暴雨' | '雪'",
        '      check:',
        '        - 剧情明确表现天气变化时更新',
        '  ' + first + ':',
        '    好感度:',
        '      type: number',
        '      range: 0~100',
        '      check:',
        '        - 依据角色对 <user> 行为的感知与反应调整 ±(3~6)',
        '        - 只在本次回复中角色确实察觉到时更新',
        '    心情:',
        '      check:',
        '        - 依据当前场景下角色的真实情绪更新',
        '    物品:',
        '      type: |-',
        '        string[]',
        '      check:',
        '        - 获得、消耗、遗失或转移物品时增删元素',
    ].join('\n');
}

/** 状态栏 HTML 兜底（模型没给状态栏时用）：纯 div + 占位符，不依赖前端正则 */
/** 状态栏三种风格：golden(鎏金) / galgame(粉紫胶囊) / minimal(单行) */
function statusBarHtml(chars, style) {
    // style=standard → 写卡器 MVU_STATUS_BAR_TEMPLATE 原文（完整文档骨架，body/style 由 AI 填）
    if (String(style || '').toLowerCase() === 'standard') return WC_STATUS_TEMPLATE;
    const list = Array.isArray(chars) && chars.length ? chars : ['角色'];
    const first = list[0];
    const st = String(style || 'golden');

    // 每个数值都走 Number 守卫：开局变量还是字符串占位词时进度条不会炸
    const num = (v, d) => `Number(getvar("stat_data.${v}", { defaults: ${d} }) || 0)`;
    const txt = (v, d) => `<%- getvar("stat_data.${v}", { defaults: "${d}" }) %>`;
    const pct = (v) => `<%- Math.max(0, Math.min(100, ${num(v, 0)})) %>`;
    const v0 = `stat_data.${first}`;

    if (st === 'minimal') {
        return [
            '<div class="mvu-min">',
            `<span class="mvu-min-t">${first}</span>`,
            `<span class="mvu-min-i">♥ <%- ${num(`${first}.好感度`, 0)} %></span>`,
            `<span class="mvu-min-i">${txt('世界.日期', '未知')} ${txt('世界.时间', '')}</span>`,
            `<span class="mvu-min-i">${txt('世界.天气', '')}</span>`,
            '</div>',
            '<style>',
            '.mvu-min{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:8px 12px;margin:6px 0;border-radius:10px;background:rgba(20,20,24,.72);border:1px solid rgba(212,175,55,.28);font-size:13px;color:#d8d3c4;line-height:1.5}',
            '.mvu-min-t{color:#e8cf8a;font-weight:600}',
            '.mvu-min-i{color:#a9a397;font-size:12px}',
            '</style>',
            '<StatusPlaceHolderImpl/>',
        ].join('\n');
    }

    if (st === 'galgame') {
        return [
            '<div class="mvu-gal">',
            '<style>',
            '.mvu-gal{position:relative;margin:10px 0;padding:12px 14px;border-radius:18px;background:linear-gradient(135deg,rgba(46,26,58,.94),rgba(24,18,40,.94));border:1px solid rgba(255,158,214,.38);box-shadow:0 6px 22px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.08);color:#f4e9f5;font-size:13px;line-height:1.6;overflow:hidden}',
            '.mvu-gal::before{content:"";position:absolute;inset:-40% -10% auto -10%;height:70%;background:radial-gradient(60% 90% at 30% 0%,rgba(255,148,203,.22),transparent 70%);pointer-events:none}',
            '.mvu-gal-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}',
            '.mvu-gal-ava{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:#fff;background:linear-gradient(135deg,#ff8fc8,#a564ff);box-shadow:0 2px 10px rgba(255,143,200,.45);flex:none}',
            '.mvu-gal-name{font-size:15px;font-weight:600;letter-spacing:.5px;color:#ffe7f6}',
            '.mvu-gal-stage{margin-left:auto;font-size:11px;padding:2px 9px;border-radius:999px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);color:#ffd9f2}',
            '.mvu-gal-aff{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
            '.mvu-gal-aff i{font-style:normal;font-size:11px;color:#c9a8e0;flex:none}',
            '.mvu-gal-bar{flex:1;height:7px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden}',
            '.mvu-gal-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#ff9ad4,#b77bff);box-shadow:0 0 10px rgba(255,154,212,.6)}',
            '.mvu-gal-aff b{font-size:12px;color:#ffc9e8;min-width:38px;text-align:right}',
            '.mvu-gal-rows{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px}',
            '.mvu-gal-row{display:flex;justify-content:space-between;gap:8px;padding:5px 9px;border-radius:10px;background:rgba(255,255,255,.055)}',
            '.mvu-gal-row span{font-size:11px;color:#b9a8c9}',
            '.mvu-gal-row b{font-size:12px;color:#fff3fb;font-weight:500}',
            '@media (max-width:520px){.mvu-gal-rows{grid-template-columns:1fr}.mvu-gal{padding:10px 12px}}',
            '</style>',
            '<div class="mvu-gal-head">',
            `<div class="mvu-gal-ava"><%- String(getvar("${v0}._头像字", { defaults: "${first.slice(0, 1)}" })) %></div>`,
            `<div class="mvu-gal-name">${first}</div>`,
            '<div class="mvu-gal-stage">',
            txt(`${first}._关系阶段`, '泛泛之交'),
            '</div>',
            '</div>',
            '<div class="mvu-gal-aff">',
            '<i>好感度</i>',
            `<div class="mvu-gal-bar"><div class="mvu-gal-fill" style="width:${pct(`${first}.好感度`)}%"></div></div>`,
            `<b><%- ${num(`${first}.好感度`, 0)} %></b>`,
            '</div>',
            '<div class="mvu-gal-rows">',
            `<div class="mvu-gal-row"><span>心情</span><b>${txt(`${first}.心情`, '平静')}</b></div>`,
            `<div class="mvu-gal-row"><span>衣着</span><b>${txt(`${first}.衣着.上衣`, '未知')}</b></div>`,
            `<div class="mvu-gal-row"><span>日期</span><b>${txt('世界.日期', '未知')} ${txt('世界.时间', '')}</b></div>`,
            `<div class="mvu-gal-row"><span>天气</span><b>${txt('世界.天气', '晴')}</b></div>`,
            '</div>',
            '</div>',
            '<StatusPlaceHolderImpl/>',
        ].join('\n');
    }

    // golden 默认
    return [
        '<div class="mvu-gold">',
        '<style>',
        '.mvu-gold{position:relative;margin:10px 0;padding:13px 15px;border-radius:14px;background:linear-gradient(160deg,rgba(26,23,18,.96),rgba(14,13,11,.96));border:1px solid rgba(212,175,55,.42);box-shadow:0 8px 26px rgba(0,0,0,.5),inset 0 1px 0 rgba(232,207,138,.12);color:#e6ddc9;font-size:13px;line-height:1.6}',
        '.mvu-gold::after{content:"";position:absolute;inset:0;border-radius:13px;box-shadow:inset 0 0 0 1px rgba(232,207,138,.1);pointer-events:none}',
        '.mvu-gold-head{display:flex;align-items:baseline;gap:10px;padding-bottom:9px;margin-bottom:10px;border-bottom:1px solid rgba(212,175,55,.18)}',
        '.mvu-gold-name{font-size:15px;font-weight:700;letter-spacing:1px;color:#e8cf8a;text-shadow:0 0 14px rgba(212,175,55,.28)}',
        '.mvu-gold-stage{font-size:11px;letter-spacing:.5px;color:#a8975f}',
        '.mvu-gold-stage::before{content:"◆";margin-right:4px;color:#8d7a3f}',
        '.mvu-gold-rows{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 14px}',
        '.mvu-gold-row{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:5px 0;border-bottom:1px dashed rgba(212,175,55,.13)}',
        '.mvu-gold-row:last-child{border-bottom:0}',
        '.mvu-gold-row i{font-style:normal;font-size:11px;letter-spacing:.5px;color:#8b8578;flex:none}',
        '.mvu-gold-row b{font-size:12.5px;font-weight:600;color:#efe6d2;text-align:right}',
        '.mvu-gold-aff{margin-top:10px;display:flex;align-items:center;gap:10px}',
        '.mvu-gold-aff i{font-style:normal;font-size:11px;letter-spacing:.5px;color:#8b8578}',
        '.mvu-gold-bar{flex:1;height:6px;border-radius:3px;background:linear-gradient(90deg,rgba(212,175,55,.08),rgba(212,175,55,.2));overflow:hidden}',
        '.mvu-gold-fill{height:100%;background:linear-gradient(90deg,#8d6f2a,#f0d488,#b4913c);box-shadow:0 0 12px rgba(240,212,136,.55)}',
        '.mvu-gold-aff b{font-size:12px;color:#f0d488;min-width:36px;text-align:right}',
        '@media (max-width:520px){.mvu-gold-rows{grid-template-columns:1fr}}',
        '</style>',
        '<div class="mvu-gold-head">',
        `<div class="mvu-gold-name">${first}</div>`,
        '<div class="mvu-gold-stage">',
        txt(`${first}._关系阶段`, '泛泛之交'),
        '</div>',
        '</div>',
        '<div class="mvu-gold-rows">',
        `<div class="mvu-gold-row"><i>日期</i><b>${txt('世界.日期', '未知')} ${txt('世界.时间', '')}</b></div>`,
        `<div class="mvu-gold-row"><i>天气</i><b>${txt('世界.天气', '晴')}</b></div>`,
        `<div class="mvu-gold-row"><i>心情</i><b>${txt(`${first}.心情`, '平静')}</b></div>`,
        `<div class="mvu-gold-row"><i>上衣</i><b>${txt(`${first}.衣着.上衣`, '未知')}</b></div>`,
        '</div>',
        '<div class="mvu-gold-aff">',
        '<i>好感度</i>',
        `<div class="mvu-gold-bar"><div class="mvu-gold-fill" style="width:${pct(`${first}.好感度`)}%"></div></div>`,
        `<b><%- ${num(`${first}.好感度`, 0)} %></b>`,
        '</div>',
        '</div>',
        '<StatusPlaceHolderImpl/>',
    ].join('\n');
}

/** 8 条 MVU 条目的配置：position / depth / order / constant / enabled 一律以规范为准 */
// 7 条固定条目的 meta 直接取自写卡器 ENTRY_TEMPLATES（position/depth/order/constant/enabled 逐字段一致）
const MVU_SPEC = [
    '[InitVar]初始变量',
    '[mvu_update]变量更新规则',
    '[mvu_update]变量输出格式',
    '[mvu_update]变量输出格式强调',
    '变量列表',
    '<状态栏>占位符提醒',
    '状态栏',
].map(comment => {
    const tpl = entryTemplate(comment) || {};
    return Object.assign({ comment, meta: tpl }, {
        position: tpl.position === undefined ? 4 : tpl.position,
        depth: tpl.depth === undefined ? 0 : tpl.depth,
        order: tpl.order === undefined ? 200 : tpl.order,
        constant: tpl.constant === undefined ? true : tpl.constant,
        enabled: tpl.enabled === undefined ? true : tpl.enabled,
    });
});

/* ------------------------------ 公共小工具 ------------------------------ */

/** 剥掉交付用的 <#escape-ejs> 外层：落盘到条目里必须是可执行的 EJS */
function stripEjsEscape(s) {
    return String(s || '')
        .replace(/<#escape-ejs>\s*/gi, '')
        .replace(/\s*<#\/escape-ejs>/gi, '')
        .replace(/^\s*```ejs\s*$/gim, '')
        .replace(/^\s*```\s*$/gim, '')
        .trim();
}


/** 极简 YAML 路径抽取：只认 `key:` 缩进层级，够用来核对 InitVar 与状态栏引用是否对得上 */
function yamlPaths(text) {
    const out = new Set();
    const stack = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.replace(/\t/g, '  ');
        const t = line.trim();
        if (!t || t.startsWith('#') || t.startsWith('---') || t.startsWith('- ')) continue;
        const m = line.match(/^(\s*)([^:#][^:]*):\s*(.*)$/);
        if (!m) continue;
        const indent = m[1].length;
        const key = m[2].trim();
        if (!key) continue;
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        const path = stack.map(x => x.key).concat(key).join('.');
        out.add(path);
        stack.push({ indent, key });
    }
    return out;
}

/** 状态栏 HTML 里 getvar("stat_data.xxx") 引用到的变量路径集合（去掉 stat_data. 前缀） */
function getvarPaths(html) {
    const out = new Set();
    const re = /getvar\(\s*["'`]([^"'`]+)["'`]/g;
    let m;
    while ((m = re.exec(String(html || '')))) {
        out.add(m[1].replace(/^stat_data\./, '').trim());
    }
    return out;
}

/** 递归找酒馆助手脚本树里的所有脚本（含 folder 内的） */
function flatScripts(list, out) {
    const res = out || [];
    for (const it of Array.isArray(list) ? list : []) {
        if (!it) continue;
        if (it.type === 'folder') { flatScripts(it.scripts, res); continue; }
        res.push(it);
    }
    return res;
}

function jsLiteral(v) {
    if (typeof v === 'string') return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
    return JSON.stringify(v);
}

/** 核心名：循环剥掉外层 [xxx] / <xxx> / 【xxx】 / 《xxx》 前缀，写卡器 _entryCommentCore 口径 */
function coreName(s) {
    let x = String(s || '').trim();
    let prev = null;
    while (prev !== x) {
        prev = x;
        x = x.replace(/^[\[【<《（(][^\]】>》\）)]*[\]】>》\）)]\s*/, '').trim();
    }
    return x;
}

/** 条目名别名：同一逻辑条目的不同叫法（写卡器 has4 同时认「变量列表 / 变量当前状态」） */
const CORE_ALIAS = { 变量列表: ['变量当前状态'], 占位符提醒: ['占位提醒'] };

/**
 * 判断一个已有条目是否是 comment 对应的那条。
 * 必须精确到核心名：早期用 includes 模糊匹配，「状态栏」会吃掉「<状态栏>占位符提醒」，把占位提醒正文覆盖成 HTML，
 * 条目越写越少、MVU 提示词缺一块 —— 这是写卡器反复强调「同名条目更新而不是重复新建」的原因。
 */
function matchEntry(e, comment) {
    const full = String(e.comment || '').trim();
    const base = coreName(comment);
    if (full === comment) return true;
    if (coreName(full) === base) return true;
    if ((CORE_ALIAS[base] || []).includes(coreName(full))) return true;
    if (base === '初始变量') return /^\[initvar\]/i.test(full);
    if (/占位/.test(base)) return /占位/.test(full) && coreName(full) !== '状态栏';
    return false;
}

/** 找一个对应条目：同名就更新，避免同款条目重复堆积 */
function findEntry(list, comment) {
    return list.find(e => matchEntry(e, comment)) || null;
}

async function writeEntry(book, comment, content, cfg) {
    const got = await getEntries({ name: book, limit: 500 });
    const hit = findEntry(got.entries || [], comment);
    const args = {
        name: book,
        comment,
        content,
        position: cfg.position,
        order: cfg.order,
        depth: cfg.depth,
        constant: cfg.constant,
        enabled: cfg.enabled !== false,
        meta: cfg.meta || null,
    };
    if (hit) args.uid = hit.uid;
    return await setEntry(args);
}

/* ------------------------------ zod 变量结构脚本（第1条） ------------------------------ */

/**
 * 写卡器 v329.59 的 normalizeMvuSchemaSource 精简版：把模型写的 zod 源码变成"能直接跑"的形式。
 * 它踩过的三个坑：① import { z } from 'zod' 在酒馆助手 iframe 里会崩（z 是全局）；
 * ② 只写 schema 不注册 = 变量系统形同虚设；③ .prefault(null) 前不 .nullable() 会在开局初始化时报类型错。
 */
function normalizeSchema(src) {
    let out = String(src || '');
    out = out.replace(/^\s*```[a-z]*\s*\r?\n([\s\S]*?)\r?\n```\s*$/i, '$1');
    out = out.replace(/^\s*import\s*\{[^}]*\bz\b[^}]*\}\s*from\s*['"][^'"]*['"];?[ \t]*$/gm, '');
    out = out.replace(/const\s+[A-Za-z_$][\w$]*\s*=\s*z\.object/, 'export const Schema = z.object');
    // AI 常只给裸 z.object({...})：没有 export const Schema = 时，在第一个 z. 处补上（写卡器模板要求固定导出名）
    if (!/export\s+const\s+Schema\s*=/.test(out)) {
        const zi = out.search(/\bz\./);
        if (zi >= 0) out = out.slice(0, zi) + 'export const Schema = ' + out.slice(zi);
    }
    if (!/mvu_zod\.js/.test(out)) {
        out = "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';\n\n" + out.replace(/^\s+/, '');
    }
    if (!/registerMvuSchema\s*\(\s*Schema\s*\)/.test(out)) {
        out += '\n\n$(() => { registerMvuSchema(Schema); });';
    } else if (!/\$\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?registerMvuSchema/.test(out)) {
        out = out.replace(/^\s*registerMvuSchema\s*\(\s*Schema\s*\)\s*;?[ \t]*$/m, '$(() => { registerMvuSchema(Schema); });');
    }
    // .prefault(null) 前面补 .nullable()：对象字面量那一档单独处理（逐链扫描遇到 } 会跳过）
    out = out.replace(/\}\s*\)\s*\.prefault\(\s*null\s*\)/g, '}).nullable().prefault(null)');
    let from = 0;
    let guard = 0;
    while (from < out.length && guard++ < 800) {
        const m = /\.prefault\s*\(\s*null\s*\)/.exec(out.slice(from));
        if (!m) break;
        const idx = from + m.index;
        const cs = out.slice(0, idx).lastIndexOf('z.');
        let insert = false;
        if (cs >= 0) {
            const chain = out.slice(cs, idx);
            insert = /^z\.[A-Za-z_$]/.test(chain) && chain.length < 240 && chain.indexOf(';') < 0
                && !/\.nullable\s*\(/.test(chain) && chain.indexOf('}') < 0;
        }
        if (insert) {
            out = out.slice(0, idx) + '.nullable()' + out.slice(idx);
            from = idx + 11 + m[0].length;
        } else {
            from = idx + m[0].length;
        }
    }
    return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ------------------------------ 酒馆助手脚本位写入 ------------------------------ */

/**
 * 写/更新角色卡「酒馆助手」脚本（data.extensions.tavern_helper.scripts）。
 * 字段严格对齐 JS-Slash-Runner 的 Script 结构（src/type/scripts.ts）：
 *   type='script' / enabled / name / id / content / info / button{enabled, buttons[]} / data{} / export_with{data,button}
 * 少字段会被 zod 默认补上，但存进卡里时带全字段，导出到别人手里才不会丢按钮或数据。
 * 判重按 id 优先、其次 name——id 是酒馆助手识别固定脚本的唯一依据（mvu-schema / 961f366d… 都靠它）。
 */
async function putScript(ctx, local, av, item) {
    // v1.30：照抄写卡器「写入酒馆」——整块 extensions 走统一通道（edit-attribute → merge → TavernHelper），
    // 不再单个 key 深合并；旧实现手写 header 缺 CSRF，手机上 403，还会被 merge 把 scripts 吞成 0 条。
    let created = false;
    let out = null;
    let channel = '';
    const before = local?.data?.extensions?.tavern_helper?.scripts?.length || 0;
    const r2 = await writeCardExtensions(av, ext => {
        const th = (ext.tavern_helper = ext.tavern_helper || {});
        if (!Array.isArray(th.scripts)) th.scripts = [];
        if (!th.variables || typeof th.variables !== 'object') th.variables = {};
        const scripts = th.scripts.slice();
        const base = Object.assign({ type: 'script', enabled: true, content: '', info: '', button: { enabled: true, buttons: [] }, data: {}, export_with: { data: true, button: true } }, item);
        Object.keys(base).forEach(k => { if (base[k] === undefined) delete base[k]; });
        const idx = scripts.findIndex(s => s && ((base.id && s.id === base.id) || (base.name && String(s.name || '') === base.name)));
        if (idx >= 0) scripts[idx] = Object.assign({}, scripts[idx], base);
        else scripts.push(base);
        th.scripts = scripts;
        created = idx < 0;
        out = base;
        return ext;
    });
    channel = r2.channel;
    ctx.saveSettingsDebounced?.();
    const after = local?.data?.extensions?.tavern_helper?.scripts?.length || 0;
    return {
        created,
        id: out?.id,
        name: out?.name,
        bytes: String(out?.content || '').length,
        scripts: after,
        before,
        channel,
        tried: r2.tried,
        note: after >= before ? '' : '回读的脚本数比写入前还少：检查是否被酒馆助手覆盖',
    };
}

/* ------------------------------ 工具 ------------------------------ */

export const TOOLS = [
    {
        name: 'mvu.templates',
        kind: 'read',
        desc: '取 MVU 变量系统的规范模板与 8 条条目配置（初始变量 YAML 骨架、更新规则、<UpdateVariable> 输出格式、变量列表、状态栏占位提醒、状态栏 HTML 骨架）。写卡前先调它，照着结构创作，不要自己发明字段名。',
        params: {
            chars: 'array 角色名列表（可空，默认["角色"]）',
            style: 'string 可选，状态栏风格 golden(鎏金默认) / galgame(粉紫胶囊) / minimal(单行)',
        },
        run: async a => {
            const chars = a.chars || [];
            return {
                ok: true,
                entries: MVU_SPEC,
                initvar: initVarYaml(chars),
                update_rule: updateRuleYaml(chars),
                output_format: OUTPUT_FORMAT,
                output_emphasis: OUTPUT_EMPHASIS,
                var_list: VAR_LIST,
                placeholder: PLACEHOLDER,
                status_bar: statusBarHtml(chars, a.style),
                status_bar_styles: ['standard', 'golden', 'galgame', 'minimal'].map(x => ({ style: x, html: statusBarHtml(chars, x) })),
                rules: [
                    'InitVar 用 YAML，键名=中文变量名；数字写 0、布尔写 false、字符串写占位词、对象写 {}，不要编剧情数值。',
                    '`_` 开头=只读（AI 可见不可改）；`$` 开头=派生显示（AI 不可见，只给脚本/EJS 用）。',
                    '变量更新规则里禁止用 TS interface，一律 YAML 的 type / range / check。',
                    '不许在 InitVar 的 YAML 和变量名里写 {{...}} 酒馆宏——它在初始化时会被替换成乱码。',
                    'MVU 需要用户先在扩展里装 MagVarUpdate（MagVariableUpdate）并注册 zod schema 脚本，否则这些条目只是静态文本；不确定就调 mvu.doctor 逐环诊断。',
                    '状态栏 HTML 里 getvar 引用的变量必须和 InitVar 里写的路径严格一致（含大小写与层级），否则那格永远显示 defaults。',
                ],
            };
        },
    },
    {
        name: 'mvu.build',
        kind: 'write',
        desc: '把 MVU 的 7 条世界书条目一次写全（照抄写卡器 ENTRY_TEMPLATES 与正文生成，不做自创）：条目名归一为标准名（[InitVar]初始变量 / [mvu_update]变量更新规则 / [mvu_update]变量输出格式 / [mvu_update]变量输出格式强调 / 变量列表 / <状态栏>占位符提醒 / 状态栏），meta 逐字段照模板（InitVar position=0 order=100 enabled=false、三条 mvu_update position=4 depth=0 order=200、变量列表 depth=1、占位提醒 order=250 带 keys、状态栏 position=2 depth=2 order=35 触发式），正文默认用写卡器固定生成（变量列表只留 --- + <status_current_variable>{{format_message_variable::stat_data}}</…>，输出格式/强调/占位提醒强制重建，InitVar 与更新规则用它的骨架）。同名条目更新不新建。',
        params: {
            book: 'string 世界书名（先用 world.list 查）',
            chars: 'array 角色名列表',
            initvar: 'string 可选，AI 创作后的 [InitVar] YAML 正文（含或不含 stat_data 根都行）',
            update_rule: 'string 可选，AI 创作的变量更新规则 YAML',
            status_bar: 'string 可选，状态栏 HTML（读 stat_data 用 getvar）',
        },
        run: async a => {
            const book = a.book;
            if (!book) throw new Error('mvu.build 需要 book（世界书名）');
            const chars = a.chars || [];
            // 正文默认值 = 写卡器固定生成（不传就用它，传了也按条目规范归一，与写卡器 _tavernWriteMvuEntries 同口径）
            const initvar = String(a.initvar || '').trim() || wcInitVarYaml(chars);
            const rule = String(a.update_rule || '').trim() || wcVarUpdateRule(chars);
            const bar = String(a.status_bar || '').trim() || statusBarHtml(chars);
            const rawContents = {
                '[InitVar]初始变量': initvar,
                '[mvu_update]变量更新规则': rule,
                '[mvu_update]变量输出格式': wcVarOutputFormat(),
                '[mvu_update]变量输出格式强调': wcVarOutputEmphasis(),
                变量列表: wcVarListContent(),
                '<状态栏>占位符提醒': wcStatusPlaceholder(),
                状态栏: bar,
            };
            const contents = {};
            for (const [k, v] of Object.entries(rawContents)) {
                const name = normalizeEntryComment(k) || k;
                contents[name] = normalizeEntryContent(name, v);
            }
            const done = [];
            for (const spec of MVU_SPEC) {
                const name = normalizeEntryComment(spec.comment) || spec.comment;
                const content = contents[name];
                const out = await writeEntry(book, name, content, spec);
                done.push({ comment: name, uid: out.uid, enabled: spec.enabled, position: spec.position, depth: spec.depth, order: spec.order, chars: String(content).length });
            }
            return { ok: true, book, written: done.length, entries: done, note: '条目不生效时先确认 MagVarUpdate 已安装、schema 脚本已注册' };
        },
    },
    {
        name: 'ejs.build',
        kind: 'write',
        desc: '生成 EJS 多阶段人设的一组条目：1 个控制器（启用、常驻、只读变量 + getwi 派发）+ N 个阶段条目（禁用、只放该阶段差异正文）。分支按数值上界顺序编译成 if / else if / else，最后一档自动作为 else 兜底。控制器里自动带 typeof 守卫，不会重复声明崩掉。',
        params: {
            book: 'string 世界书名',
            char: 'string 角色名（条目命名前缀）',
            var_path: 'string 变量路径，不带 stat_data 前缀，如 关系系统.好感度',
            defaults: 'any 初始值（数字/字符串/布尔）',
            branches: 'array 按上界从低到高：[{ "max": 30, "stage": "阶段01_陌生", "body": "该阶段差异正文" }, ...]，最后一项可以只给 stage+body',
            fallback: 'object 可选，兜底档 { "stage": "...", "body": "..." }；不给则用最后一项的 stage',
        },
        run: async a => {
            const book = a.book;
            const char = a.char || '角色';
            const varPath = String(a.var_path || '').trim();
            if (!book) throw new Error('ejs.build 需要 book');
            if (!varPath) throw new Error('ejs.build 需要 var_path，例如 关系系统.好感度');
            const branches = Array.isArray(a.branches) ? a.branches : [];
            if (!branches.length) throw new Error('ejs.build 需要至少一个分支');
            const names = [];
            const vn = 'mv_' + varPath.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '_');
            const lit = jsLiteral(a.defaults === undefined ? 0 : a.defaults);
            const ctrlName = char + '_阶段控制器';
            const lines = [];
            lines.push('<%# @qk-unit | 工件=多阶段人设控制器 | 单元=控制器 | 依据=条件表 | 边界=只读变量并派发 | 完成=分支闭合 %>');
            lines.push(`<%_ if (typeof ${vn} === 'undefined') var ${vn} = getvar('stat_data.${varPath}', { defaults: ${lit} }); _%>`);
            // 条件编译：数值上界走 <=，枚举走 ===，两类可混排；缺 max 的项只当兜底，绝不能生成孤立 else
            const cmpOf = b => (typeof b.max === 'number' ? '<=' : (typeof b.max === 'string' ? '===' : null));
            const conds = branches.filter(b => cmpOf(b));
            const tail = branches.filter(b => !cmpOf(b)).pop() || null;
            if (!conds.length) {
                const only = tail || branches[0];
                lines.push(`<%- await getwi('${only.stage}') %>`);
                names.push(only.stage);
            } else {
                let first = true;
                for (const b of conds) {
                    const op = cmpOf(b);
                    // 第二档起必须自带 } 关闭上一档的块，否则 (cond){ else if 直接语法错
                    const head = first ? 'if' : '} else if';
                    lines.push(`<%_ ${head} (${vn} ${op} ${op === '<=' ? b.max : jsLiteral(b.max)}) { _%>`);
                    first = false;
                    lines.push(`<%- await getwi('${b.stage}') %>`);
                    names.push(b.stage);
                }
                const fb = a.fallback && a.fallback.stage ? a.fallback : (tail || conds[conds.length - 1]);
                lines.push('<%_ } else { _%>');
                lines.push(`<%- await getwi('${fb.stage}') %>`);
                if (!names.includes(fb.stage)) names.push(fb.stage);
                lines.push('<%_ } _%>');
            }
            lines.push('<%# @qk-complete | 工件=多阶段人设控制器 | 已闭合=变量读取,条件覆盖,getwi派发,EJS结构 %>');
            const controller = stripEjsEscape(lines.join('\n'));

            const written = [];
            written.push({
                comment: ctrlName,
                uid: (await writeEntry(book, ctrlName, controller, { position: 1, depth: 0, order: 10, constant: true, enabled: true })).uid,
                enabled: true,
            });
            for (const b of branches) {
                const body = String(b.body || '').trim();
                if (!body) continue;
                const out = await writeEntry(book, b.stage, body, { position: 1, depth: 0, order: 1, constant: false, enabled: false });
                written.push({ comment: b.stage, uid: out.uid, enabled: false });
            }
            if (a.fallback && a.fallback.stage && a.fallback.body) {
                const out = await writeEntry(book, a.fallback.stage, String(a.fallback.body).trim(), { position: 1, depth: 0, order: 1, constant: false, enabled: false });
                written.push({ comment: a.fallback.stage, uid: out.uid, enabled: false });
            }
            return {
                ok: true,
                book,
                controller: ctrlName,
                stages: names,
                written,
                sample: controller.slice(0, 600),
                rules: [
                    '阶段条目正文不得包含 <% 或 %>，否则会被当脚本执行。',
                    '阶段条目必须禁用（enabled=false），由控制器 getwi 加载；平时不注入。',
                    '控制器不写任何阶段正文，只读变量 + 派发。',
                ],
            };
        },
    },
    {
        name: 'ejs.audit',
        kind: 'read',
        desc: '审计一本书里的 EJS 条目：路径是否带 stat_data、有没有 typeof 守卫、getwi 的目标条目是否真实存在、阶段条目是否被误设为启用、EJS 标签是否闭合、变量是否都是数值/枚举/真假这类可比较类型。',
        params: { book: 'string 世界书名' },
        run: async a => {
            if (!a.book) throw new Error('ejs.audit 需要 book');
            const got = await getEntries({ name: a.book, limit: 500 });
            const all = got.entries || [];
            const issues = [];
            const notes = [];
            for (const e of all) {
                const c = String(e.content || '');
                const cmt = String(e.comment || '');
                const isCtrl = /\bgetwi\s*\(/.test(c) || /await\s+getwi/.test(c);
                // 阶段条目：阶段01_陌生 / 阶段一 这类命名才判；「X_阶段控制器」不算阶段条目
                const isStage = !isCtrl && /阶段\s*0?\d|阶段[一二三四五六七八九十]/.test(cmt);
                if (!isCtrl && !isStage) continue;
                if (isCtrl) {
                    if (/getvar\(\s*['"]stat_data\./.test(c) === false && /getvar\(/.test(c)) {
                        issues.push(`控制器「${cmt}」：getvar 路径缺少 stat_data. 前缀`);
                    }
                    if (/getvar\(/.test(c) && !/typeof\s+\w+\s*===\s*['"]undefined['"]/.test(c) && !/@@private/.test(c)) {
                        issues.push(`控制器「${cmt}」：缺少 typeof 守卫，多条目同变量时会重复声明崩溃`);
                    }
                    const targets = [...c.matchAll(/getwi\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
                    const missing = targets.filter(t => !all.some(x => String(x.comment || '').trim() === t));
                    if (missing.length) issues.push(`控制器「${cmt}」：getwi 目标无对应条目 → ${missing.join('、')}`);
                    if (e.enabled === false) issues.push(`控制器「${cmt}」被禁用：控制器必须启用（蓝灯常驻）`);
                } else if (isStage) {
                    if (/<%/.test(c)) issues.push(`阶段条目「${cmt}」正文里含 <%：会被当脚本执行，应只放纯文本差异正文`);
                    if (e.enabled !== false) issues.push(`阶段条目「${cmt}」处于启用状态：应禁用，由控制器 getwi 加载`);
                }
            }
            for (const e of all) {
                if (!/getvar\(|getwi\(|@\w+\s*$|@@/m.test(String(e.content || ''))) continue;
                const keys = [...String(e.content).matchAll(/getvar\(\s*['"]stat_data\.([^'"]+)['"]/g)].map(m => m[1]);
                if (keys.length) notes.push(`「${e.comment}」读取路径：${keys.join('、')}`);
            }
            return { ok: true, book: a.book, entries: all.length, issues, paths: notes, ok_count: issues.length === 0 };
        },
    },
    {
        name: 'mvu.schema',
        kind: 'write',
        desc: '把 zod 变量结构脚本写进角色卡的「酒馆助手」脚本位（id=mvu-schema、name=变量结构）。自动剥掉 import { z } from "zod"（z 在酒馆助手 iframe 里是全局，裸 import 会崩）、补 mvu_zod 导入头、把 export const Schema = z.object 规范化、给 .prefault(null) 补 .nullable()、补 $(() => registerMvuSchema(Schema)) 注册尾。注意 schema 必须放脚本位，写成世界书条目会灌进提示词且完全不生效。',
        params: {
            card: 'string 头像文件名，默认当前角色',
            schema: 'string zod 源码（以 z.object({...}) 链为主）',
        },
        run: async a => {
            const ctx = c();
            const av = a.card || ctx.characterId;
            const local = (ctx.characters || []).find(x => x.avatar === av);
            if (!local) throw new Error(`找不到角色卡「${av}」`);
            if (!a.schema || !String(a.schema).trim()) throw new Error('mvu.schema 需要 schema 源码');
            const code = normalizeSchema(a.schema);
            if (!/z\.object/.test(code)) throw new Error('schema 里没有 z.object：确认这是 zod 结构定义');
            const item = { type: 'script', enabled: true, name: '变量结构', id: 'mvu-schema', content: code, info: '自动生成的 MVU 变量结构脚本。', button: { enabled: true, buttons: [] }, data: {}, export_with: { data: true, button: true } };
            const out = await putScript(ctx, local, av, item);
            return { ok: true, avatar: av, id: 'mvu-schema', bytes: code.length, created: out.created, scripts: out.scripts, registered: /registerMvuSchema\s*\(\s*Schema\s*\)/.test(code), note: '脚本头尾按写卡器模板归一（import registerMvuSchema → export const Schema = z.object({...}) → $(() => registerMvuSchema(Schema))）；MVU 生效还需要本体脚本：调 mvu.runtime 写 bundle.js 那一份（id 961f366d-e403-45c2-8155-3d14ec86de53），正则调 mvu.statusbar' };
        },
    },
    {
        name: 'mvu.runtime',
        kind: 'write',
        desc: '写 MVU 本体脚本（酒馆助手脚本位里的第二份，id=961f366d-e403-45c2-8155-3d14ec86de53、name=MVU）。内容只有一行 import 指向 MagVarUpdate 的 bundle.js，并带上 5 个隐藏按钮（重新处理变量 / 重新读取初始变量 / 快照楼层 / 重演楼层 / 重试额外模型解析 / 清除旧楼层变量）。很多卡「schema 写了但变量不动」就是因为卡里只有变量结构、没有这份本体：MagVarUpdate 的运行时根本没挂上。',
        params: {
            card: 'string 头像文件名，默认当前角色',
            bundle_url: 'string 可选，替换 bundle.js 的 import 地址（默认 MagVarUpdate artifact）',
        },
        run: async a => {
            const ctx = c();
            const av = a.card || ctx.characterId;
            const local = (ctx.characters || []).find(x => x.avatar === av);
            if (!local) throw new Error(`找不到角色卡「${av}」`);
            const url = String(a.bundle_url || 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js').trim();
            if (!/^https?:\/\//.test(url)) throw new Error('bundle_url 必须是 http(s) 地址');
            const buttons = ['重新处理变量', '重新读取初始变量', '快照楼层', '重演楼层', '重试额外模型解析', '清除旧楼层变量'].map(name => ({ name, visible: false }));
            const item = {
                type: 'script',
                enabled: true,
                name: 'MVU',
                id: '961f366d-e403-45c2-8155-3d14ec86de53',
                content: `import'${url}';`,
                info: '',
                button: { enabled: true, buttons },
                data: {},
                export_with: { data: true, button: true },
            };
            const out = await putScript(ctx, local, av, item);
            return { ok: true, avatar: av, id: '961f366d-e403-45c2-8155-3d14ec86de53', content: item.content, created: out.created, scripts: out.scripts, note: '本体脚本只负责挂 runtime；变量结构仍需 mvu.schema 写一份' };
        },
    },
    {
        name: 'mvu.statusbar',
        kind: 'write',
        desc: '照抄 我的写卡器-v329.59.js 的「写入酒馆」：世界书「状态栏」条目（position=2、depth=2、order=35，内容纯 HTML，读 stat_data 用 getvar）+ 卡级正则一整套 6 条固定脚本（思维链剥离 d668c8a6、只发最新2楼变量 5bb4b588、[美化]变量完成 6fb572ae、[美化]变量更新中 bf1b7441、[不发送]隐藏状态栏标记 mvu-status-hide、[美化]MVU状态栏 mvu-status-bar）。第 6 条的 replaceString 自动 ```html 包裹（酒馆助手按 fence 建 iframe，裸 HTML 不渲染）。6 条都写在角色卡正则位（scoped）并自动开闸，只对这张卡生效。',
        params: {
            book: 'string 世界书名',
            html: 'string 可选，自定义状态栏 HTML（必须含 <StatusPlaceHolderImpl/>）；不传就用 style 模板',
            style: 'string 可选，golden(鎏金默认) / galgame(粉紫胶囊) / minimal(单行)',
            enable_hide: 'boolean 可选，默认 true，创建「不发送」正则',
            card: 'string 可选，头像文件名（正则写到哪张卡，留空用当前角色）',
            chars: 'array 可选，角色名列表（套模板时用，默认取当前角色名）',
        },
        run: async a => {
            if (!a.book) throw new Error('mvu.statusbar 需要 book');
            const chars = Array.isArray(a.chars) && a.chars.length ? a.chars : [String(charBy(a.card)?.name || '角色')];
            // 照抄写卡器：条目里存纯 HTML；正则里由 fixedMvuRegexes 自动 ```html 包裹
            const html = unwrapHtml(String(a.html || '').trim() || statusBarHtml(chars, a.style));
            if (!/StatusPlaceHolderImpl/.test(html)) throw new Error('状态栏 HTML 里必须保留 <StatusPlaceHolderImpl/> 占位符');
            const spec = { position: 2, depth: 2, order: 35, constant: false, enabled: true };
            const written = await writeEntry(a.book, '状态栏', html, spec);

            // 正则写角色卡（scoped）：MVU 状态栏只属于这张卡，写全局会把别卡的占位符也一起换掉
            const ch = charBy(a.card);
            if (!ch) throw new Error('MVU 状态栏正则必须挂在角色卡上，但当前没有角色卡（群聊/未开卡）：先打开目标角色或传 card=头像文件名');

            // ★照抄 我的写卡器-v329.59.js 的 _tavernWriteRegexScripts：一次写全 6 条固定正则
            const hide = a.enable_hide !== false;
            const fixed = fixedMvuRegexes(html);
            for (const rx of fixed) {
                if (!hide && (rx.id === 'mvu-status-hide')) continue;
                await upsertScoped(ch, Object.assign({ disabled: false, substituteRegex: 2 }, rx));
            }

            // 回读核对：6 条必须真的在这张卡的 regex_scripts 里，且开关是开的
            const after = scopedScripts(charBy(a.card));
            const problems = [];
            for (const rx of fixed) {
                if (!hide && rx.id === 'mvu-status-hide') continue;
                if (!after.some(r => r && r.id === rx.id)) problems.push(`「${rx.scriptName}」没写进卡的正则位（id=${rx.id}）`);
            }
            if (!scopedAllowed(charBy(a.card))) problems.push('这张卡的正则开关没打开（character_allowed_regex），正则不会生效');
            if (!after.some(r => r && r.id === 'mvu-status-bar' && String(r.replaceString || '').indexOf('```html') >= 0)) {
                problems.push('[美化]MVU状态栏 的 replaceString 没有 ```html 包裹：酒馆助手按 fence 渲染状态栏，裸 HTML 不会建 iframe');
            }

            return {
                ok: problems.length === 0,
                book: a.book,
                entry_uid: written.uid,
                regex_scope: 'scoped',
                character: ch.avatar,
                regex: '写卡器 6 条固定正则（思维链/变量剥离/变量完成/变量更新中/隐藏占位/状态栏）' + (hide ? '' : '（enable_hide=false，跳过隐藏占位）'),
                fixed_ids: FIXED_MVU_REGEX_IDS,
                regex_total_in_card: after.length,
                problems,
                bytes: html.length,
            };
        },
    },
    {
        name: 'mvu.preview',
        kind: 'read',
        desc: '状态栏预览：把状态栏 HTML 真的跑起来看。照抄写卡器 showMvuStatusBarPreview —— 自动补全 HTML 骨架（AI 只给片段也能跑）、在 <head> 最前面注入 mock（$ / _ / getVariables / getAllVariables / waitUntil / waitGlobalInitialized / eventOn / Mvu / getvar / print）、把 [InitVar] 条目 YAML 解析成 stat_data 当假数据。返回可直接塞 iframe srcdoc 的完整文档，不写盘。状态栏白屏/不显示变量时先跑这个：能在浏览器里跑，问题就在卡里；跑不起来，问题在 HTML。',
        params: {
            book: 'string 可选，世界书名（读 [InitVar] 当假数据；不传就不解析）',
            card: 'string 可选，头像文件名（读卡里 mvu-status-bar 正则的 replaceString 当 HTML）',
            html: 'string 可选，直接给状态栏 HTML（优先于卡里那条）',
            stat_data: 'object 可选，自定义假变量（优先级最高）',
        },
        run: async a => {
            const ctx = c();
            let html = String(a.html || '').trim();
            let source = 'html 参数';
            if (!html) {
                const ch = charBy(a.card) || (ctx.characterId ? charBy(ctx.characterId) : null);
                const rx = ch ? scopedScripts(ch).find(r => r && r.id === 'mvu-status-bar') : null;
                if (rx) { html = String(rx.replaceString || '').trim(); source = '卡内 [美化]MVU状态栏 正则'; }
            }
            if (!html) { html = WC_STATUS_TEMPLATE; source = '写卡器标准模板（卡里还没有状态栏正则）'; }

            let data = a.stat_data && typeof a.stat_data === 'object' ? a.stat_data : null;
            let dataSource = data ? 'stat_data 参数' : '';
            if (!data && a.book) {
                try {
                    const got = await getEntries({ name: a.book, limit: 500 });
                    const iv = (got.entries || []).find(e => String(e.comment || '').toLowerCase().indexOf('[initvar]') === 0);
                    if (iv && String(iv.content || '').trim()) {
                        data = parseInitVarYaml(iv.content);
                        dataSource = `[InitVar] 条目（uid=${iv.uid}）`;
                    }
                } catch { /* 读不到就退示例数据 */ }
            }
            if (!data || !Object.keys(data).length) {
                data = { 世界: { 当前日期: '2025-07-22', 当前时间: '09:00', 天气: '晴' }, 主角: { 好感度: 30, 心情: '平静', 物品: [] } };
                dataSource = '示例假数据';
            }
            const doc = injectMock(html, data);
            return {
                ok: true,
                source,
                data_source: dataSource,
                bytes: doc.length,
                skeleton_fixed: ensureHtmlDoc(html) !== String(html || '').trim(),
                html: doc,
                note: '把 html 字段整段塞进 <iframe sandbox="allow-scripts" srcdoc="…"> 就能看到真实渲染；这里只 mock 了读变量，不 mock 写变量',
            };
        },
    },
    {
        name: 'fe.chat',
        kind: 'write',
        desc: '0 层卡前端聊天界面（照抄写卡器 FE_CHAT_BASE_HTML）：气泡式聊天 + 静默调模型（window.parent.TavernHelper.generate，带 should_stream / disable_extras / stop_everything）+ 消息只在前端 iframe 渲染（state.messages，不建酒馆楼层）+ Enter 发送 / Shift+Enter 换行 + 流式回显。不传 book 只回预览片段；传 book 就把整份 HTML 写进世界书条目（position=0 常驻，order=240），由卡内前端脚本注入。',
        params: {
            title: 'string 可选，<title> 文案（默认「聊天界面」）',
            char: 'string 可选，角色名（只加在标题后缀）',
            book: 'string 可选，世界书名；给了就把整份 HTML 落成条目',
            comment: 'string 可选，条目名（默认 [前端]聊天界面）',
            preview_chars: 'number 可选，返回片段长度，默认 600',
        },
        run: async a => {
            const html = feChatHtml({ title: a.title, char: a.char });
            const n = Math.max(200, Math.min(2000, Number(a.preview_chars) || 600));
            let written = null;
            if (a.book) {
                const comment = normalizeEntryComment(String(a.comment || '[前端]聊天界面')) || '[前端]聊天界面';
                const out = await writeEntry(a.book, comment, html, { position: 0, depth: 0, order: 240, constant: true, enabled: true });
                written = { book: a.book, comment, uid: out.uid };
            }
            return {
                ok: true,
                bytes: html.length,
                lines: html.split('\n').length,
                written,
                skeleton: ['callParentApi', 'sendMessage', 'renderMessage', 'state.messages', 'should_stream', 'stop_everything'].filter(k => html.indexOf(k) >= 0),
                preview: html.slice(0, n),
                note: written
                    ? '整份已落盘到世界书；前端注入方式：createScriptIdIframe() 或 iframe srcdoc 指向该条目内容'
                    : '传 book 才会落盘；现在是预览片段，需要整份就带 book 再调一次',
            };
        },
    },
    {
        name: 'mvu.doctor',
        kind: 'read',
        desc: 'MVU 变量系统的逐环诊断，只读不写。查六件事：MagVarUpdate 扩展装没装、卡里有没有注册 zod 变量结构的脚本（registerMvuSchema）、7 条世界书条目齐不齐且 position/depth/order/constant 合不合规范、InitVar 里真有的变量与状态栏 HTML 里 getvar 引用的是否逐条对得上、写卡器那 6 条固定正则（含两条状态栏）是否落在卡上并开了闸、占位符是否只出现一次。返回 problems（坏在哪一环）+ fixes（按顺序照做）+ notes（不致命但对不上）。做卡做到「状态栏不显示」时先跑它，别自己猜。',
        params: {
            book: 'string 可选，世界书名；不给就用当前角色绑定的世界书',
            card: 'string 可选，头像文件名；不给用当前角色',
        },
        run: async a => {
            const problems = [];
            const fixes = [];
            const notes = [];
            const ch = charBy(a.card);
            const extOf = chx => (chx && chx.data && chx.data.extensions) || {};
            const book = String(a.book || extOf(ch).world || '').trim();

            // ① MagVarUpdate 扩展
            let mvuDir = '';
            for (const dir of ['MagVarUpdate', 'MagVariableUpdate', 'mvu']) {
                try {
                    const r = await fetch(`/scripts/extensions/third-party/${dir}/index.js`, { method: 'HEAD' });
                    if (r && r.ok) { mvuDir = dir; break; }
                } catch { /* 探测失败按没装处理 */ }
            }
            if (!mvuDir) {
                problems.push('没探测到 MagVarUpdate（/scripts/extensions/third-party/MagVarUpdate/index.js 不是 200）');
                fixes.push('先装 MagVarUpdate 扩展；装完刷新页面再跑一次 mvu.doctor');
            }

            // ② zod 变量结构脚本
            const th = extOf(ch).tavern_helper || {};
            const scripts = flatScripts(th.scripts);
            const schemaHits = scripts.filter(x => /registerMvuSchema/.test(String(x.content || '')));
            if (!ch) {
                problems.push('当前没有角色卡（群聊或未开卡），MVU 状态栏与卡级正则都无处可挂');
                fixes.push('先打开目标角色再跑');
            } else if (!scripts.length) {
                problems.push('这张卡没有酒馆助手脚本（data.extensions.tavern_helper.scripts 为空）');
                fixes.push('装「酒馆助手（JS-Slash-Runner）」并把界面换成酒馆助手渲染；脚本/正则里的 EJS 要有它才执行');
            } else if (!schemaHits.length) {
                problems.push('卡里的脚本没有一个含 registerMvuSchema：变量没有类型约束，更新会飘');
                fixes.push('用 mvu.schema 生成「变量结构」脚本（会自动剥 import、改成 export const Schema = z.object）');
            }
            const schemaEnabled = schemaHits.filter(x => x.enabled !== false);
            if (schemaHits.length && !schemaEnabled.length) {
                problems.push('变量结构脚本存在但被禁用了');
                fixes.push('script.folder 或酒馆助手里把「变量结构」脚本 enabled 打开');
            }

            // ③ 世界书 7 条 + 配置
            let entries = [];
            if (!book) {
                problems.push('这张卡没绑定世界书（data.extensions.world 为空），InitVar / 更新规则 / 状态栏都读不到');
                fixes.push('先 lora/lore.bind 或角色卡设置里绑定世界书，或用 mvu.build 指定 book 建一套');
            } else {
                try {
                    const got = await getEntries({ name: book, limit: 500 });
                    entries = got.entries || [];
                } catch (e) {
                    problems.push(`世界书「${book}」读不出来：${e && e.message ? e.message : e}`);
                    fixes.push('world.list 确认名字拼写，注意是全名不是简称');
                }
            }
            const byComment = new Map(entries.map(e => [String(e.comment || ''), e]));
            const missingSpec = [];
            for (const spec of MVU_SPEC) {
                const hit = byComment.get(spec.comment);
                if (!hit) { missingSpec.push(spec.comment); continue; }
                const diffs = [];
                if (Number(hit.position) !== spec.position) diffs.push(`position ${hit.position}≠${spec.position}`);
                if (Number(hit.depth) !== spec.depth) diffs.push(`depth ${hit.depth}≠${spec.depth}`);
                if (Number(hit.order) !== spec.order) diffs.push(`order ${hit.order}≠${spec.order}`);
                if (!!hit.constant !== !!spec.constant) diffs.push(`constant ${!!hit.constant}≠${spec.constant}`);
                if (!!hit.enabled !== (spec.enabled !== false)) diffs.push(`enabled ${!!hit.enabled}≠${spec.enabled !== false}`);
                if (diffs.length) {
                    problems.push(`条目「${spec.comment}」配置不对：${diffs.join('，')}`);
                    fixes.push(`world.upsertEntry 按规范重写「${spec.comment}」的位置/深度/顺序（用 mvu.build 最省事，它会按规范铺）`);
                }
            }
            if (missingSpec.length) {
                problems.push(`缺 ${missingSpec.length} 条 MVU 条目：${missingSpec.join('、')}`);
                fixes.push('mvu.build 一次性补齐这 7 条（同名会更新不会重复新建）');
            }

            // ④ 变量名对齐
            const initEntry = byComment.get('[InitVar]初始变量');
            const barEntry = byComment.get('状态栏');
            if (initEntry && barEntry) {
                const vars = yamlPaths(String(initEntry.content || '').replace(/<#escape-ejs>[\s\S]*?<\/#escape-ejs>/g, ''));
                const refs = getvarPaths(barEntry.content);
                const missing = [...refs].filter(p => !vars.has(p));
                if (missing.length) {
                    problems.push(`状态栏引用了 InitVar 里不存在的变量（那几格永远显示 defaults）：${missing.slice(0, 12).join('、')}${missing.length > 12 ? ` 等 ${missing.length} 个` : ''}`);
                    fixes.push('二选一：在 InitVar 里补上这些路径（注意层级与大小写完全一致），或把状态栏里对应 getvar 换成真实存在的变量名');
                }
                const unused = [...vars].filter(p => !refs.has(p) && !p.includes('.') && p !== '世界' && p !== '主角');
                if (unused.length) notes.push(`InitVar 里有 ${unused.length} 个顶层变量状态栏没用到（正常，剧情变量不必都上栏）：${unused.slice(0, 8).join('、')}`);
                if (!/<StatusPlaceHolderImpl\/>/.test(String(barEntry.content || ''))) {
                    problems.push('「状态栏」条目里没有 <StatusPlaceHolderImpl/> 占位符，脚本找不到替换位置');
                    fixes.push('mvu.statusbar 重写这一条（它会带占位符），自定义 HTML 时别把占位符删了');
                }
            } else if (initEntry || barEntry) {
                notes.push('InitVar 或 状态栏 只有一条，无法做变量名对齐检查');
            }

            // ⑤ 写卡器 6 条固定正则
            const rs = scopedScripts(ch);
            const ids = FIXED_MVU_REGEX_IDS.slice();
            const hitIds = ids.filter(id => rs.some(r => r && r.id === id));
            if (ids.length !== hitIds.length) {
                const lost = ids.filter(id => !hitIds.includes(id));
                problems.push(`卡里缺 MVU 固定正则 ${lost.length} 条：${lost.join('、')}（写卡器同一套 6 条，缺哪条对应环节就断）`);
                fixes.push('mvu.statusbar 重跑一遍：它照抄写卡器 _tavernWriteRegexScripts，一次补齐 6 条并自动开闸');
            }
            const sample = { 'mvu-status-hide': '<StatusPlaceHolderImpl/>', 'mvu-status-bar': '<StatusPlaceHolderImpl/>', 'd668c8a6-fa6a-444d-a5d6-8f68b73a3c36': '<Analysis>x</Analysis>', '5bb4b588-23ca-4564-8df5-882104eff764': '<UpdateVariable><x/></UpdateVariable>', '6fb572ae-a9ea-436d-9779-ad100f1ff7f5': '<UpdateVariable><x/></UpdateVariable>', 'bf1b7441-5cf1-426d-bd6c-911332be9923': '<UpdateVariable><x/>' };
            for (const r of rs.filter(x => x && ids.includes(x.id))) {
                const raw = String(r.findRegex || '');
                const mm = raw.match(/^\/([\s\S]+)\/([a-z]*)$/);
                if (!mm) { problems.push(`正则「${r.scriptName || r.id}」的 findRegex 不是 /.../flags 形式，引擎不会认`); continue; }
                try {
                    const re = new RegExp(mm[1], mm[2]);
                    const probe = sample[r.id] || '';
                    if (probe && !re.test(probe)) {
                        problems.push(`正则「${r.scriptName || r.id}」匹配不到样例 ${probe.slice(0, 28)}，等于没写`);
                        fixes.push('mvu.statusbar 重跑（照抄写卡器的那 6 条 findRegex 已校验过）');
                    }
                } catch (e) {
                    problems.push(`正则「${r.scriptName || r.id}」编译失败：${e && e.message ? e.message : e}`);
                }
                if (r.disabled) { problems.push(`正则「${r.scriptName || r.id}」是禁用状态`); fixes.push('把它 disabled 关掉（或 mvu.statusbar 重跑）'); }
                if (r.id === 'mvu-status-bar' && String(r.replaceString || '').indexOf('```html') < 0) {
                    problems.push('[美化]MVU状态栏 的 replaceString 没有 ```html 包裹：酒馆助手按 fence 渲染，裸 HTML 不建 iframe');
                    fixes.push('mvu.statusbar 重跑（照抄版会自动 ```html 包裹）');
                }
            }
            if (ch && !scopedAllowed(ch)) {
                problems.push('这张卡的正则开关没开（character_allowed_regex 不含它的 avatar），卡级正则一条都不会跑');
                fixes.push('mvu.statusbar 或 regex.upsert 会自动开闸；手动开就在「正则 → Scoped」里勾上这张卡');
            }

            return {
                ok: problems.length === 0,
                card: ch ? ch.avatar : '',
                book,
                mvu_dir: mvuDir || '',
                scripts: scripts.length,
                schema_scripts: schemaHits.length,
                entries_found: entries.length,
                problems,
                fixes,
                notes,
            };
        },
    },
    {
        name: 'mvu.audit',
        kind: 'read',
        desc: '按写卡器 v329.59 checkMvu8Entries 的口径验收一本书的 MVU 八条：①-⑦ 条目是否存在（核心名匹配，兼容 [MVU]变量列表 / 变量当前状态 等变体）+ 每条 position/depth/order/constant/enabled 是否合规范 + 内容特征是否齐（变量列表要 format_message_variable::stat_data、占位提醒要 StatusPlaceHolderImpl、InitVar 不能含 {{ 宏）+ ⑧ 状态栏两条正则是否就位 + 第 1 条 zod schema 脚本是否存在且没有裸 import z。返回 missing 清单与可直接照做的修法。写完 MVU 卡后必须跑一次，空 list 才算完成。',
        params: { book: 'string 世界书名', card: 'string 可选，头像文件名（查 schema 脚本用，默认当前角色）' },
        run: async a => {
            if (!a.book) throw new Error('mvu.audit 需要 book');
            const got = await getEntries({ name: a.book, limit: 500 });
            const all = got.entries || [];
            const issues = [];
            const warnings = [];
            const found = [];
            const missing = [];
            const hitOf = spec => findEntry(all, spec.comment);
            const dupOf = spec => all.filter(e => matchEntry(e, spec.comment));
            const FEATURE = {
                '[InitVar]初始变量': [[/^[\w\u4e00-\u9fa5].*:/m, '缺少 YAML 键值行'], [/stat_data/i, null]],
                '变量列表': [[/format_message_variable::stat_data/, '缺少 {{format_message_variable::stat_data}} 宏（变量不会显示）']],
                '<状态栏>占位符提醒': [['StatusPlaceHolderImpl', '缺少 <StatusPlaceHolderImpl/> 占位符']],
                '状态栏': [['StatusPlaceHolderImpl', '缺少 <StatusPlaceHolderImpl/> 占位符'], [/getvar\s*\(/, '没有 getvar 读取 stat_data，状态栏会是静态死文本']],
            };
            for (const spec of MVU_SPEC.slice(0, 6).concat([MVU_SPEC[6]])) {
                const hit = hitOf(spec);
                if (!hit) { missing.push(spec.comment); continue; }
                found.push({ comment: spec.comment, uid: hit.uid, actual: hit.comment });
                const dupes = dupOf(spec).length;
                if (dupes > 1) issues.push(`「${spec.comment}」匹配到 ${dupes} 条重复条目：同样内容会被注入多份，先用 world 工具删到 1 条`);
                const diff = [];
                if (Number(hit.position) !== spec.position) diff.push(`position ${hit.position}→${spec.position}`);
                if (Number(hit.depth) !== spec.depth) diff.push(`depth ${hit.depth}→${spec.depth}`);
                if (Number(hit.order) !== spec.order) diff.push(`order ${hit.order}→${spec.order}`);
                if (!!hit.constant !== !!spec.constant) diff.push(`constant ${!!hit.constant}→${spec.constant}`);
                if (!!hit.enabled !== !!spec.enabled) diff.push(`enabled ${!!hit.enabled}→${spec.enabled}`);
                if (diff.length) issues.push(`「${spec.comment}」配置不合规范：${diff.join('，')}（调 mvu.build 会强制纠正）`);
                const body = String(hit.content || '');
                for (const [pat, msg] of (FEATURE[spec.comment] || [])) {
                    if (!msg) continue;
                    const ok = pat instanceof RegExp ? pat.test(body) : body.indexOf(pat) >= 0;
                    if (!ok) issues.push(`「${spec.comment}」${msg}`);
                }
                if (spec.comment === '[InitVar]初始变量') {
                    if (/\{\{/.test(body)) issues.push('「[InitVar]初始变量」含 {{...}} 酒馆宏：初始化时会被替换成乱码，必须删掉');
                    const nums = [...body.matchAll(/:\s*(-?\d+(?:\.\d+)?)\s*$/gm)].map(m => Number(m[1]).valueOf());
                    const nonZero = nums.filter(n => n !== 0);
                    if (nonZero.length) warnings.push(`「[InitVar]初始变量」有 ${nonZero.length} 个非 0 数值（${nonZero.slice(0, 5).join('、')}）：初始值应为中性 0，编造剧情数值会让开局状态失真`);
                }
            }
            // 第 8 条：状态栏显示 / 隐藏两条正则
            let regIssues = 0;
            try {
                // 两张表一起查：卡级（scoped）优先，全局也算（历史遗留的写全局版本仍能跑）
                const ch = charBy(a.card);
                const rx = allRegexes(ch);
                const show = rx.filter(r => /StatusPlaceHolder/.test(String(r.findRegex || '')) && r.markdownOnly === true && r.promptOnly !== true);
                const hide = rx.filter(r => /StatusPlaceHolder/.test(String(r.findRegex || '')) && r.promptOnly === true);
                if (!show.length) { issues.push('第8条 缺「[美化]MVU状态栏」正则（markdownOnly=true）：占位符不会被替换成状态栏 HTML'); regIssues++; }
                if (!hide.length) { warnings.push('缺「[不发送]隐藏状态栏标记」正则（promptOnly=true）：占位符会被发给模型，诱导它抄占位符'); }
                // 写在卡里但开关没开 = 等于没写，这是最隐蔽的一种"做了但没生效"
                const scopedShow = show.filter(r => r.scope === 'scoped');
                if (scopedShow.length && !scopedAllowed(ch)) {
                    issues.push('状态栏正则写在这张卡里，但这张卡的正则开关没打开（character_allowed_regex 里没有它的 avatar）：正则一条都不会跑。用 regex.upsert 重写一次会自动开闸，或让用户在「正则」页签手动打开。');
                    regIssues++;
                }
            } catch (e) {
                warnings.push('读不到扩展正则设置：' + e.message);
            }
            // 第 1 条：zod schema 脚本必须存脚本位；同时必须挂 MVU 本体（两份脚本才算齐）
            let schema = { exist: false, bare_import: false, registered: false, name: '' };
            let runtime = { exist: false, name: '' };
            try {
                const ctx = c();
                const av = a.card || ctx.characterId;
                const ch = (ctx.characters || []).find(x => x.avatar === av);
                const ext = ((ch || {}).data || {}).extensions || {};
                const scripts = (ext.tavern_helper || {}).scripts || [];
                const list = Array.isArray(scripts) ? scripts : [];
                const rt = list.find(x => {
                    if (!x) return false;
                    if (x.id === '961f366d-e403-45c2-8155-3d14ec86de53') return true;
                    const code = String(x.content || '');
                    return code.indexOf('MagVarUpdate') >= 0 || code.indexOf('bundle.js') >= 0;
                });
                if (rt) runtime = { exist: true, name: String(rt.name || rt.id || '') };
                const s = list.find(x => {
                    const code = String((x || {}).content || '');
                    return /registerMvuSchema|z\.object/.test(code);
                });
                if (s) {
                    const code = String(s.content || '');
                    schema = { exist: true, bare_import: /^\s*import\s*\{[^}]*\bz\b[^}]*\}\s*from\s*['"][^'"]*['"]/m.test(code), registered: /registerMvuSchema\s*\(/.test(code), name: String(s.name || s.id || '') };
                    if (schema.bare_import) issues.push('schema 脚本里有裸 import { z } from "zod"：酒馆助手 iframe 里 z 是全局，这行会让脚本直接崩（用 mvu.schema 重写）');
                    if (!schema.registered) issues.push('schema 脚本没调 registerMvuSchema(Schema)：变量系统不会接管，条目只是静态文本');
                } else {
                    issues.push('第1条 缺 zod 变量结构脚本（必须存角色卡脚本位，不是世界书条目；用 mvu.schema 写）');
                }
                if (!runtime.exist) issues.push('缺 MVU 本体脚本（id 961f366d-e403-45c2-8155-3d14ec86de53 / 内容含 bundle.js）：只有变量结构、没有本体时 MagVarUpdate 运行时没挂上，变量永远不动（用 mvu.runtime 写）');
            } catch (e) {
                warnings.push('读不到角色卡脚本位：' + e.message);
            }
            const okAll = missing.length === 0 && issues.length === 0;
            return {
                ok: true,
                book: a.book,
                entries: all.length,
                done: found.map(f => f.actual),
                missing,
                issues,
                warnings,
                schema,
                runtime,
                ok_all: okAll,
                next: okAll ? '八条 + 两份脚本齐备，可开始写正文' : [
                    missing.length ? '缺条目：调 mvu.build 一次补齐（会强制纠正配置）' : '',
                    issues.some(x => /schema/.test(x)) ? 'schema 问题：调 mvu.schema 重写脚本位' : '',
                    issues.some(x => /本体脚本/.test(x)) ? '缺 MVU 本体：调 mvu.runtime 写 bundle.js 那一份' : '',
                    regIssues ? '正则缺失：调 mvu.statusbar 建两条正则' : '',
                ].filter(Boolean),
            };
        },
    },
    {
        name: 'script.upsert',
        kind: 'write',
        desc: '写/更新角色卡「酒馆助手」脚本位里的任意一份脚本（data.extensions.tavern_helper.scripts）。字段按 JS-Slash-Runner 的 Script 规范（type/enabled/name/id/content/info/button/data/export_with），按 id 优先、其次 name 判重，不会重复堆积。用于：挂 MVU 本体或第三方插件、写自定义事件监听/挂界面逻辑、把一段会执行的 JS 塞进卡里。注意脚本会在酒馆助手的 iframe 里执行，写之前先拿到可执行内容；纯文本设定请用世界书条目而不是脚本。',
        params: {
            card: 'string 头像文件名，默认当前角色',
            name: 'string 脚本名（显示在脚本列表里）',
            id: 'string 可选，唯一 id；不传则按 name 判重',
            content: 'string 脚本 JS 源码（完整正文）',
            enabled: 'boolean 可选，默认 true',
            buttons: 'array 可选，脚本按钮 [{ "name": "按钮名", "visible": false }]',
            data: 'object 可选，脚本自带数据',
        },
        run: async a => {
            const ctx = c();
            const av = a.card || ctx.characterId;
            const local = (ctx.characters || []).find(x => x.avatar === av);
            if (!local) throw new Error(`找不到角色卡「${av}」`);
            if (!a.name) throw new Error('script.upsert 需要 name');
            if (!String(a.content || '').trim()) throw new Error('script.upsert 需要 content');
            const item = {
                type: 'script',
                enabled: a.enabled !== false,
                name: String(a.name),
                id: a.id || undefined,
                content: String(a.content),
                info: '',
                button: { enabled: true, buttons: Array.isArray(a.buttons) ? a.buttons : [] },
                data: a.data && typeof a.data === 'object' ? a.data : {},
                export_with: { data: true, button: true },
            };
            if (!item.id) delete item.id;
            const out = await putScript(ctx, local, av, item);
            return { ok: true, avatar: av, name: item.name, id: out.id || null, created: out.created, scripts: out.scripts, before: out.before, channel: out.channel, tried: out.tried, enabled: item.enabled };
        },
    },
    {
        name: 'todo.write',
        kind: 'read',
        desc: '维护本会话的任务清单：把多步工作拆成具体任务、标记进行中、完成后逐项勾掉。每次调用整表替换（没有逐条编辑、没有回读），同一份列表跨轮次、跨重开会话都在。只改会话状态，不动卡片与世界书。条目是 { content, status }，status 取 pending / in_progress / completed；content 必须非空、不重复，单条不超过 200 字。长任务（写一整张卡、批量改世界书）应该先写清单再动手。',
        params: {
            todos: 'array 必填，每次都是完整列表：[{ content: "…", status: "pending" }]',
        },
        run: async a => {
            const counts = setTodos(a.todos, { allowParallelInProgress: true });
            return `Updated todo list: ${counts.pending} pending, ${counts.inProgress} in progress, ${counts.completed} completed.`;
        },
    },
    {
        name: 'goal.get',
        kind: 'read',
        desc: '读本会话当前目标：objective、phase（active / paused / blocked / complete）、revision、Round 进度与 blocker。只存状态、不调度工作。',
        params: {},
        run: async () => ({ goal: getGoal() }),
    },
    {
        name: 'goal.create',
        kind: 'read',
        desc: '为本会话创建长期完成目标（每会话只有一个；未完成的旧目标必须先 edit / pause / block / clear 掉）。只改会话状态。多步且要跨多轮的任务才需要目标，单轮任务不要建。',
        params: {
            objective: 'string 必填，要达成什么，一句话',
            maxGoalRounds: 'number 可选，Round 上限，默认 256',
        },
        run: async a => changeGoal('create', { objective: a.objective, maxGoalRounds: a.maxGoalRounds }),
    },
    {
        name: 'goal.update',
        kind: 'read',
        desc: '修改当前目标。action 取 edit / pause / resume / complete / block / clear；edit 改 objective 或上限，block 必须给 lower-kebab-case 的 blockerCode 与说明，clear 会移除目标但留下 tombstone。带 revision 时会被校验，拿旧视图改会被明确拒绝，这时先用 goal.get 重读。',
        params: {
            action: 'string 必填，edit / pause / resume / complete / block / clear',
            revision: 'number 可选，当前 revision（比较并设置，防止旧视图覆盖）',
            objective: 'string 可选，edit 时的新目标',
            maxGoalRounds: 'number 可选，edit 时的 Round 上限',
            blockerCode: 'string block 时必填，lower-kebab-case，例如 budget-exhausted / needs-user-input',
            blockerNote: 'string 可选，block 的人话说明',
        },
        run: async a => {
            const goal = changeGoal(a.action, {
                revision: a.revision,
                objective: a.objective,
                maxGoalRounds: a.maxGoalRounds,
                blockerCode: a.blockerCode,
                blockerNote: a.blockerNote,
            });
            return { goal, note: a.action === 'clear' ? '已清除当前目标，revision 留在 tombstone 里' : '' };
        },
    },
    {
        name: 'session.list',
        kind: 'read',
        desc: '列出本插件的会话（id / 标题 / 条数 / token / 是否已压缩 / 最后更新），当前会话标 active。跨会话接活时先用它找目标，再用 session.peek 取有界快照。',
        params: {},
        run: async () => ({ items: listSessionsBrief() }),
    },
    {
        name: 'session.peek',
        kind: 'read',
        desc: '读另一个会话的有界只读快照（任务与结论，上限 chars 字，默认 1200，最多 4000），用来接上「上次写到哪」而不是重放整段历史。省略 id 就是当前会话。',
        params: { id: 'string 可选，会话 id（session.list 里拿）', chars: 'number 可选，快照字符上限，默认 1200' },
        run: async a => {
            const snap = snapshotSession(a.id, a.chars);
            if (!snap) throw new Error('没有这个会话');
            return snap;
        },
    },
    {
        name: 'usage.get',
        kind: 'read',
        desc: '看当前会话的上下文占用：system / 对话各多少 token、检查点多少、压缩阈值多少、是否已压缩。口径是 CJK 一字≈1 token（DSH 的 4 字符/token 对中文会低估到压缩来不及）。',
        params: { id: 'string 可选，会话 id，默认当前' },
        run: async a => usageOf(a.id),
    },
    {
        name: 'spill.list',
        kind: 'read',
        desc: '列出本会话里因过大被 spill 的工具结果（id / 工具名 / 原长 / 预览）。上下文里只放了修剪版（头 4096 + 尾 1024）时，用它能确认完整原文还在、并拿到 id。',
        params: {},
        run: async () => ({ ok: true, items: listSpill() }),
    },
    {
        name: 'spill.read',
        kind: 'read',
        desc: '按 id 分段取回 spill 里保存的工具结果原文（默认每次 6000 字，带 offset 往后翻，单次上限 20000）。结果被修剪过时，需要中间细节就用它，不要去重复调用那个昂贵的原工具。',
        params: {
            id: 'string spill id（spill.list 里拿）',
            offset: 'number 可选，起点字符，默认 0',
            limit: 'number 可选，本次长度，默认 6000',
        },
        run: async a => {
            if (!a.id) throw new Error('spill.read 需要 id');
            const r = readSpill(null, String(a.id), a.offset, a.limit);
            if (!r) throw new Error(`没有 spill #${a.id}（可能已被更新的 spill 淘汰，或不属于当前会话）`);
            return r;
        },
    },
];

export default TOOLS;
