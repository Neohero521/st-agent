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
        '  <div class="mvustatus-title">{{char}} · ' + first + '</div>',
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

/** 找一个"核心名"匹配的已有条目：优先精确 comment，其次包含匹配，避免同款条目重复堆积 */
function findEntry(list, comment) {
    const exact = list.find(e => String(e.comment || '').trim() === comment);
    if (exact) return exact;
    const core = comment.replace(/^\[[^\]]*\]/, '').replace(/^<[^>]*>/, '').trim();
    if (!core) return null;
    return list.find(e => String(e.comment || '').includes(core)) || null;
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
            const numeric = typeof a.defaults === 'number' || branches.every(b => typeof b.max === 'number');
            branches.forEach((b, i) => {
                if (typeof b.max === 'number' && numeric) {
                    const kw = i === 0 ? 'if' : 'else if';
                    lines.push(`<%_ ${kw} (${vn} <= ${b.max}) { _%>`);
                } else if (typeof b.max === 'string') {
                    const kw = i === 0 ? 'if' : 'else if';
                    lines.push(`<%_ ${kw} (${vn} === ${jsLiteral(b.max)}) { _%>`);
                } else {
                    lines.push('<%_ } else { _%>');
                }
                lines.push(`<%- await getwi('${b.stage}') %>`);
                names.push(b.stage);
            });
            const fb = a.fallback && a.fallback.stage ? a.fallback : branches[branches.length - 1];
            lines.push('<%_ } else { _%>');
            lines.push(`<%- await getwi('${fb.stage}') %>`);
            if (!names.includes(fb.stage)) names.push(fb.stage);
            lines.push('<%_ } _%>');
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
                const isStage = /_阶段\d*_?/.test(cmt);
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
            const data = local.data || {};
            const ext = (data.extensions = data.extensions || {});
            const th = (ext.tavern_helper = ext.tavern_helper || {});
            const scripts = Array.isArray(th.scripts) ? th.scripts.slice() : [];
            const item = { type: 'script', enabled: true, name: '变量结构', id: 'mvu-schema', content: code, info: '', button: { enabled: true, buttons: [] }, data: {} };
            const idx = scripts.findIndex(s => s && (s.id === 'mvu-schema' || /变量结构/.test(String(s.name || ''))));
            if (idx >= 0) scripts[idx] = Object.assign({}, scripts[idx], item);
            else scripts.push(item);
            const nested = { extensions: { tavern_helper: { scripts } } };
            const body = { avatar: av, data: Object.assign({}, data, nested), extensions: nested.extensions };
            const res = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(`写入失败：HTTP ${res.status}`);
            Object.assign(local, { data: Object.assign({}, data, nested), extensions: nested.extensions });
            ctx.saveSettingsDebounced?.();
            return { ok: true, avatar: av, id: 'mvu-schema', bytes: code.length, created: idx < 0, registered: /registerMvuSchema\s*\(\s*Schema\s*\)/.test(code) };
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
            const list = ctx.extensionSettings.regex || (ctx.extensionSettings.regex = []);
            const upsertRx = (id, name, find, rep, opts) => {
                let item = list.find(r => r.id === id);
                if (!item) {
                    item = { id, scriptName: name, findRegex: '', replaceString: '', placement: ['AI_OUTPUT'], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 2 };
                    list.push(item);
                }
                Object.assign(item, { scriptName: name, findRegex: find, replaceString: rep }, opts || {});
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
];

export default TOOLS;
