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
function statusBarHtml(chars) {
    const first = (Array.isArray(chars) && chars[0]) || '角色';
    return [
        '<div class="mvustatus">',
        '  <div class="mvustatus-title">' + first + '</div>',
        '  <div class="mvustatus-row"><span>世界</span><b><%- getvar("stat_data.世界.日期", { defaults: "未知" }) %> <%- getvar("stat_data.世界.时间", { defaults: "" }) %></b></div>',
        '  <div class="mvustatus-row"><span>好感度</span><b><%- getvar("stat_data.' + first + '.好感度", { defaults: 0 }) %></b></div>',
        '</div>',
        '<StatusPlaceHolderImpl/>',
    ].join('\n');
}

/** 8 条 MVU 条目的配置：position / depth / order / constant / enabled 一律以规范为准 */
const MVU_SPEC = [
    { comment: '[InitVar]初始变量', position: 0, depth: 4, order: 100, constant: false, enabled: false },
    { comment: '[mvu_update]变量更新规则', position: 4, depth: 0, order: 200, constant: true, enabled: true },
    { comment: '[mvu_update]变量输出格式', position: 4, depth: 0, order: 200, constant: true, enabled: true },
    { comment: '[mvu_update]变量输出格式强调', position: 4, depth: 0, order: 200, constant: true, enabled: false },
    { comment: '变量列表', position: 4, depth: 1, order: 200, constant: true, enabled: true },
    { comment: '<状态栏>占位符提醒', position: 4, depth: 0, order: 200, constant: true, enabled: true },
    { comment: '状态栏', position: 2, depth: 2, order: 35, constant: false, enabled: true },
];

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
    const data = local.data || {};
    const ext = (data.extensions = data.extensions || {});
    const th = (ext.tavern_helper = ext.tavern_helper || {});
    if (!Array.isArray(th.scripts)) th.scripts = [];
    if (!th.variables || typeof th.variables !== 'object') th.variables = {};
    const scripts = th.scripts.slice();
    const base = Object.assign({ type: 'script', enabled: true, content: '', info: '', button: { enabled: true, buttons: [] }, data: {}, export_with: { data: true, button: true } }, item);
    Object.keys(base).forEach(k => { if (base[k] === undefined) delete base[k]; });
    const idx = scripts.findIndex(s => s && ((base.id && s.id === base.id) || (base.name && String(s.name || '') === base.name)));
    if (idx >= 0) scripts[idx] = Object.assign({}, scripts[idx], base);
    else scripts.push(base);
    const nested = { extensions: { tavern_helper: { scripts, variables: th.variables } } };
    const body = { avatar: av, data: Object.assign({}, data, nested), extensions: nested.extensions };
    const res = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`写入脚本位失败：HTTP ${res.status}`);
    Object.assign(local, { data: Object.assign({}, data, nested), extensions: nested.extensions });
    ctx.saveSettingsDebounced?.();
    return { created: idx < 0, id: base.id, name: base.name, bytes: String(base.content || '').length, scripts: scripts.length };
}

/* ------------------------------ 工具 ------------------------------ */

export const TOOLS = [
    {
        name: 'mvu.templates',
        kind: 'read',
        desc: '取 MVU 变量系统的规范模板与 8 条条目配置（初始变量 YAML 骨架、更新规则、<UpdateVariable> 输出格式、变量列表、状态栏占位提醒、状态栏 HTML 骨架）。写卡前先调它，照着结构创作，不要自己发明字段名。',
        params: { chars: 'array 角色名列表（可空，默认["角色"]）' },
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
                status_bar: statusBarHtml(chars),
                rules: [
                    'InitVar 用 YAML，键名=中文变量名；数字写 0、布尔写 false、字符串写占位词、对象写 {}，不要编剧情数值。',
                    '`_` 开头=只读（AI 可见不可改）；`$` 开头=派生显示（AI 不可见，只给脚本/EJS 用）。',
                    '变量更新规则里禁止用 TS interface，一律 YAML 的 type / range / check。',
                    '不许在 InitVar 的 YAML 和变量名里写 {{...}} 酒馆宏——它在初始化时会被替换成乱码。',
                    'MVU 需要用户先在扩展里装 MagVarUpdate（MagVariableUpdate）并注册 zod schema 脚本，否则这些条目只是静态文本。',
                ],
            };
        },
    },
    {
        name: 'mvu.build',
        kind: 'write',
        desc: '一次性把 MVU 变量系统的 7 条世界书条目写进指定世界书（InitVar / 更新规则 / 输出格式 / 格式强调 / 变量列表 / 占位提醒 / 状态栏），配置全部按规范强制（position、depth、order、constant、enabled），同名条目会被更新而不是重复新建。initvar / update_rule / status_bar 不传则用规范骨架。',
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
            const initvar = String(a.initvar || '').trim() || initVarYaml(chars);
            const rule = String(a.update_rule || '').trim() || updateRuleYaml(chars);
            const bar = String(a.status_bar || '').trim() || statusBarHtml(chars);
            const contents = {
                '[InitVar]初始变量': initvar,
                '[mvu_update]变量更新规则': rule,
                '[mvu_update]变量输出格式': OUTPUT_FORMAT,
                '[mvu_update]变量输出格式强调': OUTPUT_EMPHASIS,
                变量列表: VAR_LIST,
                '<状态栏>占位符提醒': PLACEHOLDER,
                状态栏: bar,
            };
            const done = [];
            for (const spec of MVU_SPEC) {
                const content = contents[spec.comment];
                const out = await writeEntry(book, spec.comment, content, spec);
                done.push({ comment: spec.comment, uid: out.uid, enabled: spec.enabled, chars: String(content).length });
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
            return { ok: true, avatar: av, id: 'mvu-schema', bytes: code.length, created: out.created, scripts: out.scripts, registered: /registerMvuSchema\s*\(\s*Schema\s*\)/.test(code), note: 'MVU 生效还需要本体脚本：调 mvu.runtime 写 bundle.js 那一份（id 961f366d-e403-45c2-8155-3d14ec86de53）' };
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
        desc: '写 MVU 状态栏这一套：世界书「状态栏」条目（position=2、depth=2、order=35，内容为完整 HTML，读 stat_data 用 getvar）+ 两条正则——[美化]MVU状态栏（把 <StatusPlaceHolderImpl/> 换成这段 HTML，只影响显示）+ [不发送]隐藏状态栏标记（发给模型前把占位符清掉，免得它照着占位符编造）。',
        params: {
            book: 'string 世界书名',
            html: 'string 状态栏 HTML（必须含 <StatusPlaceHolderImpl/> 占位符）',
            enable_hide: 'boolean 可选，默认 true，创建「不发送」正则',
        },
        run: async a => {
            if (!a.book) throw new Error('mvu.statusbar 需要 book');
            const html = String(a.html || '').trim();
            if (!html) throw new Error('mvu.statusbar 需要 html');
            if (!/StatusPlaceHolderImpl/.test(html)) throw new Error('状态栏 HTML 里必须保留 <StatusPlaceHolderImpl/> 占位符');
            const spec = { position: 2, depth: 2, order: 35, constant: false, enabled: true };
            const written = await writeEntry(a.book, '状态栏', html, spec);
            const ctx = c();
            ctx.extensionSettings = ctx.extensionSettings || {};
            const list = ctx.extensionSettings.regex || (ctx.extensionSettings.regex = []);
            const upsertRx = (id, name, find, rep, opts) => {
                let item = list.find(r => r.id === id);
                if (!item) {
                    item = { id, scriptName: name, findRegex: '', replaceString: '', placement: [2], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 2 };
                    list.push(item);
                }
                Object.assign(item, { scriptName: name, findRegex: find, replaceString: rep }, opts || {});
                // placement 必须是数字数组，写字符串会被引擎判成不匹配（正则存在但完全不生效）
                item.placement = toPlacement((opts && opts.placement) || [2]);
                return item;
            };
            upsertRx('mvu-status-bar', '[美化]MVU状态栏', '/<StatusPlaceHolderImpl\\/>/g', html, { markdownOnly: true, promptOnly: false, disabled: false });
            if (a.enable_hide !== false) {
                upsertRx('mvu-status-hide', '[不发送]隐藏状态栏标记', '/<StatusPlaceHolderImpl\\/>/g', '', { markdownOnly: false, promptOnly: true, disabled: false });
            }
            ctx.saveSettingsDebounced?.();
            return { ok: true, book: a.book, entry_uid: written.uid, regex: a.enable_hide !== false ? '[美化]MVU状态栏 + [不发送]隐藏状态栏标记' : '[美化]MVU状态栏', bytes: html.length };
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
                const ctx = c();
                const rx = (ctx.extensionSettings && ctx.extensionSettings.regex) || [];
                const show = rx.filter(r => /StatusPlaceHolder/.test(String(r.findRegex || '')) && r.markdownOnly === true && r.promptOnly !== true);
                const hide = rx.filter(r => /StatusPlaceHolder/.test(String(r.findRegex || '')) && r.promptOnly === true);
                if (!show.length) { issues.push('第8条 缺「[美化]MVU状态栏」正则（markdownOnly=true）：占位符不会被替换成状态栏 HTML'); regIssues++; }
                if (!hide.length) { warnings.push('缺「[不发送]隐藏状态栏标记」正则（promptOnly=true）：占位符会被发给模型，诱导它抄占位符'); }
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
            return { ok: true, avatar: av, name: item.name, id: out.id || null, created: out.created, scripts: out.scripts, enabled: item.enabled };
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
