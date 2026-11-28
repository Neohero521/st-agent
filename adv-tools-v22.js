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
import { normalizeEntryComment, entryTemplate, normalizeEntryContent, wcInitVarYaml, wcVarUpdateRule, wcVarUpdateRuleContract, wcVarOutputFormat, wcVarOutputEmphasis, wcStatusPlaceholder, wcVarListContent } from './adv-lib-wc-entries.js';
import { WC_STATUS_TEMPLATE, mockScript, ensureHtmlDoc, injectMock, parseInitVarYaml, shimStatusBarHtml } from './adv-lib-mvu-preview.js';
import { schemaFromInitVar } from './adv-lib-schema-gen.js';
import { FE_CHAT_BASE_HTML, feChatHtml } from './adv-lib-fe-template.js';
import { editText, editPreview } from './adv-lib-str-edit.js';
import { FE_SPEC, STATUSBAR_SPEC, SCRIPT_SPEC, ENTRY_SPEC, auditFrontend, auditStatusbar, auditScript, auditEntryList } from './adv-lib-spec-audit.js';
import { FE_BEAUTIFY_BASE_HTML, FE_STRUCTURED_BASE_HTML } from './adv-lib-fe-template.js';
import { planEntry, entryBody, deriveEntryKeys, inferEntryConfig, NONMVU_ENTRY_KINDS } from './adv-lib-entry-auto.js';
import { SCRIPT_RUNTIME_SPEC, scriptTemplate, SCRIPT_TEMPLATE_KINDS } from './adv-lib-script-spec.js';
import { auditCardPack, auditInitVar, auditSchema } from './adv-lib-card-audit.js';
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
    // standard → 写卡器 MVU_STATUS_BAR_TEMPLATE 原文（完整文档骨架，body/style 由 AI 填）
    if (String(style || '').toLowerCase() === 'standard') return WC_STATUS_TEMPLATE;
    const list = Array.isArray(chars) && chars.length ? chars : ['角色'];
    const first = String(list[0]);
    const raw = String(style || '').toLowerCase();
    const st = ['golden', 'galgame', 'minimal'].indexOf(raw) >= 0 ? raw : 'golden';
    // ★正则 replaceString 不执行 EJS。状态栏必须是自执行 JS 页，与教科书卡（陈天爱：0 个 <% %>、
    //   14 个 $(、1 个 getAllVariables、监听 VARIABLE_UPDATE_ENDED）完全同构：
    //   <!DOCTYPE html> + $(errorCatched(init)) + waitGlobalInitialized('Mvu') + getAllVariables + eventOn(...)
    const THEME = {
        golden: { bg: 'rgba(18,17,22,.92)', fg: '#e8dfc8', sub: '#a9a397', acc: '#d4af37', acc2: '#8c6b21', bd: 'rgba(212,175,55,.30)', r: '12px' },
        galgame: { bg: 'linear-gradient(135deg,rgba(46,26,58,.94),rgba(24,18,40,.94))', fg: '#ffe7f6', sub: '#c9a8e0', acc: '#ff8fc8', acc2: '#a564ff', bd: 'rgba(255,158,214,.38)', r: '18px' },
        minimal: { bg: 'rgba(20,20,24,.72)', fg: '#d8d3c4', sub: '#a9a397', acc: '#cbb46a', acc2: '#8a7a45', bd: 'rgba(212,175,55,.24)', r: '10px' },
    }[st];
    const NAME = JSON.stringify(first);
    return [
        '<!DOCTYPE html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="UTF-8">',
        '<style>',
        '  :root{--sb-bg:' + THEME.bg + ';--sb-fg:' + THEME.fg + ';--sb-sub:' + THEME.sub + ';--sb-acc:' + THEME.acc + ';--sb-acc2:' + THEME.acc2 + ';--sb-bd:' + THEME.bd + ';--sb-r:' + THEME.r + '}',
        '  body{margin:0;padding:0;background:transparent;color:var(--sb-fg);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}',
        '  .sb{margin:8px 0;padding:12px 14px;border-radius:var(--sb-r);background:var(--sb-bg);border:1px solid var(--sb-bd);box-shadow:0 6px 20px rgba(0,0,0,.42);font-size:13px;line-height:1.6}',
        '  .sb-head{display:flex;align-items:center;gap:9px;margin-bottom:9px}',
        '  .sb-name{font-size:15px;font-weight:600;color:var(--sb-acc);letter-spacing:.5px}',
        '  .sb-stage{margin-left:auto;font-size:11px;padding:2px 9px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid var(--sb-bd);color:var(--sb-fg);white-space:nowrap}',
        '  .sb-aff{display:flex;align-items:center;gap:8px;margin-bottom:9px}',
        '  .sb-aff i{font-style:normal;font-size:11px;color:var(--sb-sub);flex:none}',
        '  .sb-bar{flex:1;height:7px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden}',
        '  .sb-fill{height:100%;width:0;border-radius:999px;background:linear-gradient(90deg,var(--sb-acc),var(--sb-acc2));transition:width .45s cubic-bezier(.22,1,.36,1)}',
        '  .sb-val{font-size:12px;color:var(--sb-acc);min-width:40px;text-align:right}',
        '  .sb-rows{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px}',
        '  .sb-row{display:flex;justify-content:space-between;gap:8px;padding:5px 9px;border-radius:9px;background:rgba(255,255,255,.05);min-width:0}',
        '  .sb-row span{font-size:11px;color:var(--sb-sub);flex:none}',
        '  .sb-row b{font-size:12px;font-weight:500;color:var(--sb-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '  .sb-extra{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
        '  .sb-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid var(--sb-bd);color:var(--sb-sub)}',
        '  @media (max-width:420px){.sb-rows{grid-template-columns:1fr}}',
        '</style>',
        '</head>',
        '<body>',
        '<div class="sb" id="sb-root">',
        '  <div class="sb-head"><span class="sb-name" id="sb-name"></span><span class="sb-stage" id="sb-stage">—</span></div>',
        '  <div class="sb-aff"><i>好感</i><div class="sb-bar"><div class="sb-fill" id="sb-fill"></div></div><b class="sb-val" id="sb-val">0</b></div>',
        '  <div class="sb-rows">',
        '    <div class="sb-row"><span>时间</span><b id="sb-time">—</b></div>',
        '    <div class="sb-row"><span>地点</span><b id="sb-loc">—</b></div>',
        '    <div class="sb-row"><span>心情</span><b id="sb-mood">—</b></div>',
        '    <div class="sb-row"><span>衣着</span><b id="sb-cloth">—</b></div>',
        '  </div>',
        '  <div class="sb-extra" id="sb-extra"></div>',
        '</div>',
        '<script type="module">',
        `const NAME = ${NAME};`,
        'function one(obj, keys) { for (let i = 0; i < keys.length; i++) { const v = _.get(obj, keys[i]); if (v !== undefined && v !== null && v !== "") return v; } return undefined; }',
        'function show(v, d) { if (v === undefined || v === null || v === "") return d; if (typeof v === "object") { const s = Object.values(v).filter(x => x !== null && x !== undefined && x !== "").join(" / "); return s || d; } return String(v); }',
        'function render(vars) {',
        '  const all = vars || getAllVariables();',
        '  const sd = _.get(all, "stat_data") || {};',
        '  const ch = _.get(sd, NAME) || {};',
        '  const wd = _.get(sd, "世界") || {};',
        '  const aff = Number(_.get(ch, "好感度", _.get(ch, "信任", _.get(sd, "好感度", 0)))) || 0;',
        '  document.getElementById("sb-name").textContent = NAME;',
        '  document.getElementById("sb-val").textContent = String(aff);',
        '  document.getElementById("sb-fill").style.width = Math.max(0, Math.min(100, aff)) + "%";',
        '  document.getElementById("sb-stage").textContent = show(one(ch, ["_关系阶段", "关系阶段"]), "—");',
        '  document.getElementById("sb-time").textContent = show(one(wd, ["时间", "日期"]), show(one(sd, ["时间", "当前时间"]), "—"));',
        '  document.getElementById("sb-loc").textContent = show(one(wd, ["地点", "当前位置"]), show(one(sd, ["地点"]), "—"));',
        '  document.getElementById("sb-mood").textContent = show(one(ch, ["心情", "情绪"]), "—");',
        '  document.getElementById("sb-cloth").textContent = show(one(ch, ["衣着"]), "—");',
        '  const used = ["好感度", "信任", "心情", "情绪", "衣着", "_关系阶段", "关系阶段", "时间", "地点", "当前动作", "当前身体状态", "内心OS", "对男友感情", "心动值", "防备心"];',
        '  const box = document.getElementById("sb-extra");',
        '  box.innerHTML = "";',
        '  Object.keys(ch).forEach(function (k) {',
        '    if (used.indexOf(k) >= 0) return;',
        '    const v = _.get(ch, k);',
        '    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return;',
        '    const s = show(v, "");',
        '    if (!s) return;',
        '    const el = document.createElement("span");',
        '    el.className = "sb-chip";',
        '    el.textContent = k + " " + s;',
        '    box.appendChild(el);',
        '  });',
        '}',
        'async function init() {',
        '  await waitGlobalInitialized("Mvu");',
        '  await waitUntil(function () { return _.has(getVariables({ type: "message" }), "stat_data"); });',
        '  render();',
        '  eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, function (v) { render(v); });',
        '}',
        '$(errorCatched(init));',
        '</script>',
        '</body>',
        '</html>',
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

/**
 * 写卡器三类前端的自动分型：只看名字和内容特征，不猜用户意图。
 * 名字优先（[界面]正文美化 / [界面]XX面板 / [界面]聊天界面），其次看模板指纹。
 */
function inferFrontendKind(name = '', html = '') {
    const n = String(name);
    const h = String(html);
    // 名字优先级最高：写卡器的正则名就是分类标记
    if (/正文美化|美化正文|信纸|日记/.test(n)) return 'beautify';
    if (/聊天|对话|chat/i.test(n)) return 'chat';
    if (/面板|数据|论坛|任务|背包/.test(n)) return 'structured';
    if (/callParentApi|state\.messages|TavernHelper\.generate/.test(h)) return 'chat';
    if (/parseData/.test(h)) return 'structured';
    if (/extractContent/.test(h)) return 'beautify';
    return 'structured';
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

// 写卡器模板名兜底匹配：世界元数据 / 状态栏 / 统一输出格式 / 角色边界 / 禁止项
function pickEntryTemplate(comment) {
    const c = String(comment || '').trim();
    const direct = entryTemplate(c);
    if (direct) return direct;
    const core = c.replace(/^\s*[\[【][^\]】]*[\]】]\s*/, '').trim();
    if (core && core !== c) {
        const d2 = entryTemplate(core);
        if (d2) return d2;
    }
    const NAME_MAP = {
        '元数据': '世界元数据', '世界元数据': '世界元数据', '世界观': '世界元数据', '世界设定': '世界元数据',
        '状态栏': '状态栏',
        '输出格式': '统一输出格式', '统一输出格式': '统一输出格式',
        '角色边界': '角色边界',
        '禁止项': '禁止项',
    };
    if (NAME_MAP[core]) {
        const d3 = entryTemplate(NAME_MAP[core]);
        if (d3) return d3;
    }
    const cat = (c.match(/^\s*[\[【]([^\]】]+)[\]】]/) || [])[1] || '';
    if (/世界|设定/.test(cat)) return entryTemplate('世界元数据');
    if (/状态栏/.test(cat)) return entryTemplate('状态栏');
    return null;
}

// 写卡器模板名兜底匹配
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
                    'MVU 不需要装任何扩展：本体是卡内一条 `import bundle.js` 的脚本（用 mvu.runtime 写），再配 zod schema 脚本；这两份都在位运行环境才活。不确定就调 mvu.doctor 逐环诊断。',
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
            raw_rule: 'boolean 可选，true 用写卡器逐字模板（只有 type/range/check）；默认 false = 模板 + 输出契约段（<UpdateVariable> / 绝对路径 / _ 与 $ 禁改 / delta 语义）。沈曼卿那种「只列字段结构」就是契约段缺失，模型不输出更新块',
            status_bar: 'string 可选，状态栏 HTML（读 stat_data 用 getvar）',
        },
        run: async a => {
            const book = a.book;
            if (!book) throw new Error('mvu.build 需要 book（世界书名）');
            const chars = a.chars || [];
            // 正文默认值 = 写卡器固定生成（不传就用它，传了也按条目规范归一，与写卡器 _tavernWriteMvuEntries 同口径）
            let initvar = String(a.initvar || '').trim() || wcInitVarYaml(chars);
            // 写卡器口径：InitVar 顶层就是变量根（陈天爱: / 世界:）。
            // AI 常写成 stat_data: 包一层，那会让变量变成 stat_data.stat_data.X，schema 与状态栏全对不上 —— 这里直接纠正。
            if (/^\s*stat_data\s*:\s*$/m.test(initvar.split('\n')[0] || '')) {
                const lines = initvar.split('\n');
                initvar = lines.slice(1).map(l => l.replace(/^ {2}/, '')).join('\n').trim();
            }
            const rule = String(a.update_rule || '').trim() || (a.raw_rule === true ? wcVarUpdateRule(chars) : wcVarUpdateRuleContract(chars));
            const bar = String(a.status_bar || '').trim() || statusBarHtml(chars);
            const rawContents = {
                '[InitVar]初始变量': initvar,
                '[mvu_update]变量更新规则': rule,
                '[mvu_update]变量输出格式': wcVarOutputFormat(),
                '[mvu_update]变量输出格式强调': wcVarOutputEmphasis(),
                变量列表: wcVarListContent(),
                '<状态栏>占位符提醒': wcStatusPlaceholder(),
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
            return { ok: true, book, written: done.length, entries: done, status_bar_html_bytes: bar.length, note: '状态栏 HTML 不进条目（教科书卡只有「<状态栏>占位符提醒」，HTML 走正则 replaceString）：直接调 mvu.statusbar 写正则；不生效时先跑 mvu.doctor 看卡里有没有本体 bundle 脚本和 schema 脚本（不需要装扩展）' };
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
            let code = normalizeSchema(a.schema);
            if (!/z\.object/.test(code)) throw new Error('schema 里没有 z.object：确认这是 zod 结构定义');
            // 模型经常把数值写成字符串（"85"），z.number() 会直接校验失败 → 照抄教科书卡统一 coerce
            const coerced = (code.match(/z\.number\(\)/g) || []).length;
            if (coerced) code = code.replace(/z\.number\(\)/g, 'z.coerce.number()');
            const item = { type: 'script', enabled: true, name: '变量结构', id: 'mvu-schema', content: code, info: '自动生成的 MVU 变量结构脚本。', button: { enabled: true, buttons: [] }, data: {}, export_with: { data: true, button: true } };
            const out = await putScript(ctx, local, av, item);
            return { ok: true, avatar: av, id: 'mvu-schema', bytes: code.length, created: out.created, scripts: out.scripts, coerced_from_plain_number: coerced, registered: /registerMvuSchema\s*\(\s*Schema\s*\)/.test(code), note: '脚本头尾按写卡器模板归一（import registerMvuSchema → export const Schema = z.object({...}) → $(() => registerMvuSchema(Schema))）；MVU 生效还需要本体脚本：调 mvu.runtime 写 bundle.js 那一份（id 961f366d-e403-45c2-8155-3d14ec86de53），正则调 mvu.statusbar' };
        },
    },
    {
        name: 'mvu.schema.gen',
        kind: 'write',
        desc: '从 [InitVar]初始变量 自动反推 zod schema 并写进「变量结构」脚本位（照抄写卡器 generateMvuSchemaScript）。这是消灭「schema 顶层键和 InitVar 对不上」的唯一根治办法：键名/层级直接照 InitVar 生成，不可能错位。口径：null→z.string().nullable().prefault(null)（数值类字段按名字猜成 z.coerce.number().nullable().prefault(0)）、number→z.coerce.number()、空对象→z.record(...).prefault({})、非空对象→z.object 不加值、数组→z.array。头尾自动补 import registerMvuSchema 与 $(() => registerMvuSchema(Schema))。不写业务约束（clamp 之类按卡需求另加）。',
        params: {
            book: 'string 世界书名（读 [InitVar] 条目）',
            card: 'string 可选，头像文件名，默认当前角色',
            initvar: 'string 可选，直接给 InitVar YAML 正文（给了就不读 book）',
        },
        run: async a => {
            const ctx = c();
            const av = a.card || ctx.characterId;
            const local = (ctx.characters || []).find(x => x.avatar === av);
            if (!local) throw new Error(`找不到角色卡「${av}」`);
            let init = String(a.initvar || '').trim();
            if (!init) {
                if (!a.book) throw new Error('mvu.schema.gen 需要 book（或直接传 initvar）');
                const got = await getEntries({ name: a.book, limit: 500 });
                const hit = ((got && got.entries) || []).find(e => /initvar/i.test(String(e.comment || '')));
                if (!hit) throw new Error(`世界书「${a.book}」里没有 [InitVar] 条目：先写 InitVar（mvu.build）或直接传 initvar`);
                init = hit.content;
            }
            const r = schemaFromInitVar(init);
            const item = { type: 'script', enabled: true, name: '变量结构', id: 'mvu-schema', content: r.code, info: '由 [InitVar] 反推生成的 MVU 变量结构脚本。', button: { enabled: true, buttons: [] }, data: {}, export_with: { data: true, button: true } };
            const out = await putScript(ctx, local, av, item);
            return {
                ok: true,
                avatar: av,
                id: 'mvu-schema',
                top_keys: r.topKeys,
                fields: r.fields,
                bytes: r.code.length,
                created: out.created,
                scripts: out.scripts,
                note: 'schema 的顶层键已与 InitVar 强制对齐；若卡里需要 0~100 这类业务约束，再在 z.coerce.number() 后补 .transform(v => _.clamp(v, 0, 100))',
            };
        },
    },
    {
        name: 'mvu.runtime',
        kind: 'write',
        desc: '写 MVU 本体脚本（酒馆助手脚本位里的第二份，id=961f366d-e403-45c2-8155-3d14ec86de53、name=MVU）。内容只有一行 import 指向 MagVarUpdate 的 bundle.js，并带上 6 个隐藏按钮（重新处理变量 / 重新读取初始变量 / 快照楼层 / 重演楼层 / 重试额外模型解析 / 清除旧楼层变量）。很多卡「schema 写了但变量不动」就是因为卡里只有变量结构、没有这份本体：MagVarUpdate 的运行时根本没挂上。',
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
            shim: 'boolean 可选，默认 true：自动修 data?.new_variables 回调参数 + 给 waitUntil 注入 srcdoc 兜底（写卡器 _shimStatusBarHtml 同款）',
            card: 'string 可选，头像文件名（正则写到哪张卡，留空用当前角色）',
            chars: 'array 可选，角色名列表（套模板时用，默认取当前角色名）',
        },
        run: async a => {
            if (!a.book) throw new Error('mvu.statusbar 需要 book');
            const chars = Array.isArray(a.chars) && a.chars.length ? a.chars : [String(charBy(a.card)?.name || '角色')];
            // 照抄写卡器：条目里存纯 HTML；正则里由 fixedMvuRegexes 自动 ```html 包裹
            let html = unwrapHtml(String(a.html || '').trim() || statusBarHtml(chars, a.style));
            if (/<%[\s\S]*?%>/.test(html)) {
                throw new Error('状态栏 HTML 里出现了 EJS 模板语法 <% %>：正则 replaceString 不执行 EJS，玩家会看到 <%- getvar(…) %> 源码。状态栏必须是自执行 JS 页（<!DOCTYPE html> + $(() => { await waitGlobalInitialized("Mvu"); getAllVariables() … }) + eventOn(VARIABLE_UPDATE_ENDED, render)）');
            }
            if (!/StatusPlaceHolderImpl/.test(html)) throw new Error('状态栏 HTML 里必须保留 <StatusPlaceHolderImpl/> 占位符');
            if (!/<\/html>/i.test(html)) html = ensureHtmlDoc(html);
            // 照抄写卡器 _shimStatusBarHtml：修 data?.new_variables 回调参数 + 注入 waitUntil 兜底
            if (a.shim !== false) html = shimStatusBarHtml(html);
            const spec = { position: 2, depth: 2, order: 35, constant: false, enabled: true };
            // 教科书卡（陈天爱）里没有「状态栏」HTML 条目：条目只放「<状态栏>占位符提醒」，
            // HTML 只在正则 replaceString。这里按规范写提醒条目 + 清掉历史误写的 HTML 条目。
            const phTpl = entryTemplate('<状态栏>占位符提醒') || {};
            const phWritten = await writeEntry(a.book, '<状态栏>占位符提醒', wcStatusPlaceholder(), {
                position: phTpl.position === undefined ? 4 : phTpl.position,
                depth: phTpl.depth === undefined ? 0 : phTpl.depth,
                order: phTpl.order === undefined ? 250 : phTpl.order,
                constant: true,
                enabled: true,
            });
            let staleCleared = false;
            try {
                const got = await getEntries({ name: a.book, limit: 500 });
                const stale = ((got && got.entries) || []).find(e => String(e.comment || '').trim() === '状态栏' && /<(div|style|script|!DOCTYPE)/i.test(String(e.content || '')));
                if (stale) {
                    await writeEntry(a.book, '状态栏', '', { position: 2, depth: 2, order: 35, constant: false, enabled: false });
                    staleCleared = true;
                }
            } catch (e) { /* 清历史条目失败不影响主流程 */ }

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
                entry_uid: phWritten.uid,
                placeholder_entry: '<状态栏>占位符提醒',
                stale_status_entry_cleared: staleCleared,
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
            const mode = String(a.mode || 'regex').toLowerCase();
            let written = null;
            if (a.book || mode === 'regex') {
                const comment = normalizeEntryComment(String(a.comment || '[前端]聊天界面')) || '[前端]聊天界面';
                if (mode === 'regex') {
                    // 写卡器规范：HTML 挂卡内正则，条目只放输出格式说明
                    const marker = String(a.marker || 'ST_AGENT_CHAT_UI');
                    const reg = await upsertScoped(charBy(a.card || c().characterId), {
                        id: `st-agent-fe-chat-${marker.toLowerCase()}`,
                        scriptName: '[界面]聊天界面',
                        findRegex: `/${marker}/gm`,
                        replaceString: wrapHtml(html),
                        placement: [2],
                        markdownOnly: true,
                        promptOnly: false,
                        runOnEdit: true,
                        disabled: false,
                    });
                    written = { scope: 'scoped', regex: '[界面]聊天界面', id: reg.item && reg.item.id, marker, opened: reg.opened };
                    if (a.book) {
                        const out = await writeEntry(a.book, comment,
                            `---\n聊天界面输出标记:\n  rule: 每轮回复只输出一行 ${marker}，不要输出其他正文（对话在界面内进行）\n  format: ${marker}`,
                            { position: 0, depth: 0, order: 240, constant: true, enabled: true });
                        written.entry = { book: a.book, comment, uid: out.uid };
                    }
                } else {
                    if (!a.book) throw new Error('mode=entry 需要 book');
                    const out = await writeEntry(a.book, comment, html, { position: 0, depth: 0, order: 240, constant: true, enabled: true });
                    written = { scope: 'entry', book: a.book, comment, uid: out.uid, warn: 'HTML 写在条目正文会每轮占几万 token，写卡器的做法是 fe.regex' };
                }
            }
            return {
                ok: true,
                bytes: html.length,
                lines: html.split('\n').length,
                written,
                skeleton: ['callParentApi', 'sendMessage', 'renderMessage', 'state.messages', 'should_stream', 'stop_everything'].filter(k => html.indexOf(k) >= 0),
                preview: html.slice(0, n),
                note: written
                    ? (written.scope === 'scoped'
                        ? 'HTML 已挂成卡内正则（markdownOnly + placement[2] + runOnEdit）；条目只写了输出标记，符合写卡器规范。改样式请用 fe.regex 重写或 regex.edit 局部改'
                        : '整份 HTML 落到了世界书条目：token 代价高，建议改用默认 mode=regex')
                    : '现在是预览片段；传 card 自动写卡内正则，传 book+mode=entry 才写条目',
            };
        },
    },
    {
        name: 'fe.regex',
        kind: 'write',
        desc: '按写卡器规范给前端落盘：HTML 挂成卡内正则（markdownOnly + placement=[2] + runOnEdit），而不是塞进世界书条目。kind=beautify 用 <标签>…</标签> 包正文；structured 同标签但整块替换；chat / panel 用一行标记（如 ^ST_AGENT_CHAT_UI$）触发。html 不传就用对应标准模板。传 book 时额外写一条短小的输出格式条目。返回正则配置预览 + 体检结果。',
        params: {
            kind: 'string 必填，beautify / structured / chat / panel',
            card: 'string 可选，头像文件名（默认当前角色）',
            name: 'string 可选，正则名（默认按 kind 取，如「[界面]正文美化」）',
            tag: 'string 可选，标签名（beautify/structured 必填或给默认 panel）',
            marker: 'string 可选，chat/panel 的标记词（默认 ST_AGENT_CHAT_UI / ST_AGENT_PANEL_UI）',
            html: 'string 可选，HTML 全文；不传用模板',
            book: 'string 可选，同时写输出格式条目到这个世界书',
            dry_run: 'boolean 可选，只看配置不写卡',
        },
        run: async a => {
            const kind = String(a.kind || '').toLowerCase();
            if (!['beautify', 'structured', 'chat', 'panel'].includes(kind)) throw new Error('kind 只能是 beautify / structured / chat / panel');
            const ch = charBy(a.card || c().characterId);
            if (!ch) throw new Error('没有目标角色卡');
            const tag = String(a.tag || (kind === 'beautify' ? 'body' : 'panel')).replace(/[^a-zA-Z0-9_-]/g, '') || 'panel';
            const marker = String(a.marker || (kind === 'chat' ? 'ST_AGENT_CHAT_UI' : 'ST_AGENT_PANEL_UI'));
            const defName = { beautify: '[界面]正文美化', structured: '[界面]' + (a.name || '数据面板'), chat: '[界面]聊天界面', panel: '[界面]' + (a.name || '独立面板') }[kind];
            const name = String(a.name || defName);
            let html = String(a.html || '');
            if (!html) {
                if (kind === 'beautify') html = FE_BEAUTIFY_BASE_HTML;
                else if (kind === 'structured' || kind === 'panel') html = FE_STRUCTURED_BASE_HTML;
                else html = feChatHtml({ title: '聊天界面' });
            }
            const findRegex = (kind === 'beautify')
                ? `/<${tag}>([\\s\\S]*?)<\\/${tag}>/g`
                : (kind === 'structured')
                    ? `/<${tag}>[\\s\\S]*?<\\/${tag}>/gsi`
                    : `/${marker}/g`;
            const config = {
                id: `st-agent-fe-${kind}`,
                scriptName: name,
                findRegex,
                replaceString: wrapHtml(html),
                placement: [2],
                markdownOnly: true,
                promptOnly: false,
                runOnEdit: true,
                disabled: false,
            };
            const audit = auditFrontend(html, kind === 'panel' ? 'structured' : kind);
            if (a.dry_run) {
                return { ok: true, dry_run: true, kind, card: ch.avatar, config: { ...config, replaceString: config.replaceString.slice(0, 200) + '…' }, bytes: html.length, audit };
            }
            if (audit.problems.length) {
                // 有硬伤就不落盘，避免把坏模板推进真机
                return { ok: false, kind, blocked: '前端体检未过，先按 fixes 改完再写', audit, config_preview: { findRegex, scriptName: name } };
            }
            const reg = await upsertScoped(ch, config);
            let entry = null;
            if (a.book) {
                const fmtText = (kind === 'beautify')
                    ? `---\n正文格式:\n  rule: 每轮正文用 <${tag}> 和 </${tag}> 包住；标签内只放剧情正文，不含状态栏占位符、不含变量块\n  format: <${tag}>正文</${tag}>`
                    : (kind === 'structured')
                        ? `---\n面板数据格式:\n  rule: 每轮输出一个 <${tag}> 数据块（每行 key: value），不要用自然语言代替\n  format: <${tag}>…</${tag}>`
                        : `---\n界面标记:\n  rule: 每轮只输出一行 ${marker}，不要输出其他正文（交互在界面内进行）\n  format: ${marker}`;
                const out = await writeEntry(a.book, String(a.entry || name).replace(/^\[界面\]/, '[前端]'), fmtText,
                    { position: 0, depth: 0, order: 240, constant: true, enabled: true });
                entry = { book: a.book, comment: String(a.entry || name), uid: out.uid };
            }
            // 回读：确认正则真的在卡里且开关是开的
            const after = scopedScripts(charBy(ch.avatar));
            const hit = after.find(r => r && (r.id === config.id || r.scriptName === name));
            return {
                ok: !!hit,
                kind, card: ch.avatar, bytes: html.length,
                regex: hit ? { id: hit.id, name: hit.scriptName, findRegex: hit.findRegex, markdownOnly: hit.markdownOnly, placement: hit.placement, runOnEdit: hit.runOnEdit } : null,
                regex_total: after.length, opened: reg.opened,
                entry, audit,
                note: hit
                    ? '已落盘并回读。刷新聊天后 AI 下次输出标签/标记时生效；改样式用 regex.edit 局部改 replaceString'
                    : '回读没找到这条正则，检查卡的正则开关或重试',
            };
        },
    },
    {
        name: 'entry.auto',
        kind: 'read',
        desc: '照抄写卡器的条目配置推断：给条目名和正文，算出 position / depth / order / constant / selective / enabled + 自动派生 keys（名字按 · 切分 + 正文前 100 字抽词，剥 [分类]/<标签> 前缀，虚词片段丢掉，上限 8）。命中写卡器模板（世界元数据/角色边界/禁止项/统一输出格式/自定义条目/MVU 各条）时模板 meta 优先。只算不写；传 book 会回读该条目真实 meta 并列出差异。',
        params: {
            comment: 'string 必填，条目名（可带 [分类]/<标签> 前缀）',
            content: 'string 可选，条目正文（不传就只按条目名推断）',
            book: 'string 可选，世界书名；给了就与该条目现状对比',
            keys: 'array 可选，显式指定触发词（不给就派生）',
            constant: 'boolean 可选，强制常驻/触发',
        },
        run: async a => {
            if (!a.comment) throw new Error('entry.auto 需要 comment');
            const tpl = entryTemplate(String(a.comment));
            const plan = planEntry(String(a.comment), String(a.content || ''), {
                templateMeta: tpl ? { position: tpl.position, depth: tpl.depth, order: tpl.order, constant: tpl.constant, selective: tpl.selective, enabled: tpl.enabled, probability: tpl.probability, useProbability: tpl.useProbability } : null,
                keys: a.keys,
                constant: a.constant,
            });
            let actual = null;
            let diff = null;
            if (a.book) {
                const got = await getEntries({ name: a.book, limit: 500 });
                const hit = (got.entries || []).find(e => matchEntry(e, String(a.comment)));
                if (hit) {
                    actual = { uid: hit.uid, position: hit.position, depth: hit.depth, order: hit.order, constant: !!hit.constant, keys: Array.isArray(hit.key) ? hit.key : [] };
                    diff = [];
                    for (const k of ['position', 'depth', 'order', 'constant']) {
                        if (Number(actual[k]) !== Number(plan.meta[k]) && actual[k] !== plan.meta[k]) diff.push(`${k}: 现在 ${actual[k]} → 建议 ${plan.meta[k]}`);
                    }
                    const ak = (actual.keys || []).slice().sort().join('|');
                    const pk = plan.keys.slice().sort().join('|');
                    if (ak !== pk) diff.push(`keys: 现在 [${(actual.keys || []).join(',')}] → 建议 [${plan.keys.join(',')}]`);
                } else {
                    diff = ['这本书里还没有同名条目'];
                }
            }
            return { ok: true, plan, actual, diff };
        },
    },
    {
        name: 'entry.gen',
        kind: 'write',
        desc: '写一条非 MVU 骨架条目并自动配好 meta：kind=世界元数据 / 角色边界 / 禁止项 / 统一输出格式 / custom。正文不传就用写卡器风格的 YAML 骨架（中文键、短、可直接被模型理解）；meta 走 templates 优先 + inferEntryConfig 兜底，keys 自动派生。落盘走 setEntry（同名更新），写后单条体检。custom 必须给 topic 或 comment。',
        params: {
            kind: 'string 必填，世界元数据 / 角色边界 / 禁止项 / 统一输出格式 / custom',
            book: 'string 必填，世界书名',
            comment: 'string 可选，条目名（默认取 kind；custom 用它当主题）',
            content: 'string 可选，正文；不给用骨架',
            topic: 'string 可选，custom 的主题',
            keys: 'array 可选，显式触发词',
            constant: 'boolean 可选，强制常驻',
            dry_run: 'boolean 可选，只看算出的 meta 与正文',
        },
        run: async a => {
            if (!a.book) throw new Error('entry.gen 需要 book');
            const kind = String(a.kind || '').trim();
            const comment = String(a.comment || (kind === 'custom' ? (a.topic || '') : kind)).trim();
            if (!comment) throw new Error('entry.gen 需要 comment 或 topic');
            const body = String(a.content || entryBody(kind, { topic: a.topic || comment, comment }));
            const tpl = pickEntryTemplate(comment);
            const plan = planEntry(comment, body, {
                // 命中写卡器模板（世界元数据/角色边界/禁止项/统一输出格式/自定义条目）时，meta 一律以模板为准
                templateMeta: tpl ? { position: tpl.position, depth: tpl.depth, order: tpl.order, constant: tpl.constant, selective: tpl.selective, enabled: tpl.enabled, probability: tpl.probability, useProbability: tpl.useProbability } : null,
                keys: a.keys,
                constant: a.constant,
                deriveKeys: !(kind === '状态栏' || (tpl && tpl.selective === true && tpl.constant === false && kind !== 'custom')),
            });
            if (a.dry_run) return { ok: true, dry_run: true, kind, plan, body };
            const out = await writeEntry(a.book, comment, body, {
                position: plan.meta.position, depth: plan.meta.depth, order: plan.meta.order,
                constant: plan.meta.constant, enabled: plan.meta.enabled !== false,
                meta: Object.assign({}, plan.meta, { keys: plan.keys, selective: plan.meta.selective }),
            });
            const got = await getEntries({ name: a.book, limit: 500 });
            const hit = (got.entries || []).find(e => Number(e.uid) === Number(out.uid)) || (got.entries || []).find(e => matchEntry(e, comment));
            const audit = auditEntryList(hit ? [hit] : []);
            return { ok: true, kind, book: a.book, comment, uid: out.uid || (hit && hit.uid), keys: plan.keys, meta: plan.meta, notes: plan.notes, audit };
        },
    },
    {
        name: 'script.spec',
        kind: 'read',
        desc: '非 MVU 脚本运行规约（照抄写卡器 SCRIPTUI_SPEC + 悬浮球标准写法）：入口 $(()=>errorCatched(init)())、卸载 pagehide、挂载硬规则（脚本里的 $ 就是父页面 jQuery、禁 window.top.document）、三种渲染方式与样式隔离取舍、按钮注册、脚本变量必须带 script_id、错误分级、事件与防抖刷新、悬浮球拖拽与自愈、预置第三方库清单。写脚本前先读它。',
        params: { kind: 'string 可选，all / runtime / float（默认 all）' },
        run: async a => {
            const k = String(a.kind || 'all').toLowerCase();
            if (k === 'float') return { ok: true, float: SCRIPT_RUNTIME_SPEC.float, mount: SCRIPT_RUNTIME_SPEC.mount };
            if (k === 'runtime') return { ok: true, runtime: SCRIPT_RUNTIME_SPEC };
            return { ok: true, runtime: SCRIPT_RUNTIME_SPEC };
        },
    },
    {
        name: 'script.gen',
        kind: 'write',
        desc: '生成并落盘一份可直接跑的非 MVU 脚本（照写卡器规范）：kind=floating（悬浮球，纯 div + pointer 拖拽 + 位置存脚本变量 + MutationObserver 自愈）/ hud（变量小面板，MVU 事件 + MESSAGE_UPDATED 防抖 + 1.5s 巡检兜底）/ panel（独立 iframe 面板 + postMessage 回父页面）/ bar（脚本按钮 + 斜杠命令）。生成后先 script.audit 体检，有硬伤不落盘；通过则写进卡内脚本位并回读。',
        params: {
            kind: 'string 必填，floating / hud / panel / bar',
            card: 'string 可选，头像文件名（默认当前角色）',
            name: 'string 可选，脚本名（默认按 kind 取）',
            id: 'string 可选，脚本 id（默认 st-agent-gen-<kind>）',
            label: 'string 可选，显示文案 / 按钮名',
            icon: 'string 可选，floating 的图标字符',
            keys: 'array 可选，hud 要显示的变量键（默认 ["好感度"]）',
            action: 'string 可选，panel 按钮发出的文本',
            dry_run: 'boolean 可选，只生成不写卡',
        },
        run: async a => {
            const kind = String(a.kind || '').toLowerCase();
            if (!SCRIPT_TEMPLATE_KINDS.includes(kind)) throw new Error(`kind 只能是 ${SCRIPT_TEMPLATE_KINDS.join(' / ')}`);
            const ctx = c();
            const ch = charBy(a.card || ctx.characterId);
            if (!ch) throw new Error('script.gen 需要一张角色卡（当前没有开卡）');
            const name = String(a.name || { floating: '悬浮球', hud: '变量面板', panel: '独立面板', bar: '快捷按钮' }[kind]);
            const content = scriptTemplate(kind, { id: a.id || `gen${kind}`, label: a.label || name, icon: a.icon, keys: a.keys, action: a.action });
            const audit = auditScript(content, name);
            if (a.dry_run) return { ok: true, dry_run: true, kind, bytes: content.length, audit, preview: content.slice(0, 500) };
            if (audit.problems.length) return { ok: false, blocked: '脚本体检未过，先按 fixes 改模板再写', audit };
            const buttons = (kind === 'floating' || kind === 'hud' || kind === 'bar')
                ? [{ name: a.label || name, visible: kind === 'bar' }]
                : [];
            const item = {
                type: 'script',
                enabled: true,
                name,
                id: a.id || `st-agent-gen-${kind}`,
                content,
                info: '由 script.gen 生成',
                button: { enabled: true, buttons },
                data: {},
                export_with: { data: true, button: true },
            };
            const out = await putScript(ctx, ch, ch.avatar, item);
            const after = (((charBy(ch.avatar) || {}).data || {}).extensions || {}).tavern_helper || {};
            const hit = (after.scripts || []).find(x => x && (x.id === item.id || x.name === name));
            return {
                ok: !!hit, kind, card: ch.avatar, name, id: out.id || item.id,
                bytes: content.length, buttons, channel: out.channel, scripts_total: (after.scripts || []).length,
                audit,
                note: hit ? '已落盘并回读。刷新后脚本在酒馆助手 iframe 里执行；要改行为用 script.edit 局部改' : '回读没找到这份脚本，检查卡内脚本位或重试',
            };
        },
    },
    {
        name: 'script.edit',
        kind: 'write',
        desc: '行级编辑卡内脚本（照 DSH edit：old_string 字面唯一匹配，不整体重写）。给一段真实存在的原文 + 替换文，命中唯一才改；命中多时报 AMBIGUOUS 并列出每处行号，找不到时给最近似的 3 行——照这个提示缩窄再来一次，别整段重输。改完走统一写入通道落盘并回读。',
        params: {
            card: 'string 可选，头像文件名（默认当前角色）',
            id: 'string 可选，脚本 id（优先）',
            name: 'string 可选，脚本名（不含 id 时按名称包含匹配）',
            old_string: 'string 必填，要替换的原文（必须与卡里完全一致，含缩进）',
            new_string: 'string 必填，替换文；空串=删除这段',
            replace_all: 'boolean 可选，默认 false（要求唯一匹配）',
            dry_run: 'boolean 可选，只算不写',
        },
        run: async a => {
            const ctx = c();
            const ch = charBy(a.card || ctx.characterId);
            if (!ch) throw new Error('script.edit 需要一张角色卡（当前没有开卡）');
            const scripts = ((ch.data.extensions || {}).tavern_helper || {}).scripts || [];
            let idx = -1;
            if (a.id) idx = scripts.findIndex(x => x && x.id === a.id);
            if (idx < 0 && a.name) idx = scripts.findIndex(x => x && String(x.name || '').indexOf(a.name) >= 0);
            if (idx < 0) throw new Error(`卡里找不到脚本（id=${a.id || '-'} name=${a.name || '-'}）；现有：${scripts.map(x => (x && x.id) + ':' + (x && x.name)).join(', ')}`);
            const target = scripts[idx];
            const res = editText(target.content, a.old_string, a.new_string, !!a.replace_all, `脚本「${target.name}」`);
            if (!res.ok) return Object.assign({ scope: 'script', card: ch.avatar, script_id: target.id, script_name: target.name }, res);
            const preview = editPreview(target.content, res.content, a.old_string, a.new_string);
            if (a.dry_run) return { ok: true, dry_run: true, scope: 'script', script_name: target.name, replacements: res.replacements, preview };
            scripts[idx] = Object.assign({}, target, { content: res.content });
            const w = await writeCardExtensions(ch.avatar, ext => {
                ext.tavern_helper = ext.tavern_helper || {};
                ext.tavern_helper.scripts = scripts;
                return ext;
            });
            return { ok: true, scope: 'script', card: ch.avatar, script_id: target.id, script_name: target.name, replacements: res.replacements, bytes: res.content.length, channel: w.channel, preview };
        },
    },
    {
        name: 'regex.edit',
        kind: 'write',
        desc: '行级编辑某条正则（findRegex 或 replaceString），同样照 DSH edit 的唯一匹配语义。默认自动判断 old_string 落在哪个字段（两边都命中时报 AMBIGUOUS，请传 field 指定）；scope=card 写卡内正则表，scope=global 写全局正则表。',
        params: {
            card: 'string 可选，头像文件名（scope=card 时用，默认当前角色）',
            id: 'string 可选，正则 id（优先）',
            scriptName: 'string 可选，正则名（不含 id 时匹配）',
            field: 'string 可选，findRegex / replaceString（不传自动判断）',
            scope: 'string 可选，card 默认 / global',
            old_string: 'string 必填',
            new_string: 'string 必填',
            replace_all: 'boolean 可选，默认 false',
            dry_run: 'boolean 可选，只算不写',
        },
        run: async a => {
            const ctx = c();
            const scope = String(a.scope || 'card').toLowerCase();
            const list = scope === 'global'
                ? (Array.isArray(ctx.extensionSettings.regex) ? ctx.extensionSettings.regex.slice() : [])
                : scopedScripts(charBy(a.card || ctx.characterId)).slice();
            let idx = -1;
            if (a.id) idx = list.findIndex(x => x && x.id === a.id);
            if (idx < 0 && a.scriptName) idx = list.findIndex(x => x && String(x.scriptName || '').indexOf(a.scriptName) >= 0);
            if (idx < 0) throw new Error(`找不到正则（id=${a.id || '-'} name=${a.scriptName || '-'} scope=${scope}）`);
            const rx = list[idx];
            const fields = a.field ? [a.field] : ['findRegex', 'replaceString'];
            const tried = fields.map(f => ({ field: f, res: editText(String(rx[f] === undefined ? '' : rx[f]), a.old_string, a.new_string, !!a.replace_all, `正则「${rx.scriptName || rx.id}」的 ${f}`) }));
            const hit = tried.filter(t => t.res.ok || t.res.code === 'AMBIGUOUS');
            if (!hit.length) {
                return { ok: false, code: 'NOT_FOUND', scope, field_attempts: tried.map(t => ({ field: t.field, code: t.res.code })), nearest: tried[0].res.nearest, message: `${a.field ? a.field : 'findRegex/replaceString'} 里都找不到 old_string` };
            }
            if (hit.length > 1 && !a.field) {
                return { ok: false, code: 'AMBIGUOUS_FIELD', scope, message: 'old_string 同时能匹配 findRegex 与 replaceString，请传 field 指定改哪个', fields: hit.map(t => t.field) };
            }
            const t = hit[0];
            if (!t.res.ok) return Object.assign({ scope, field: t.field }, t.res);
            const preview = editPreview(String(rx[t.field]), t.res.content, a.old_string, a.new_string);
            if (a.dry_run) return { ok: true, dry_run: true, scope, field: t.field, replacements: t.res.replacements, preview };
            rx[t.field] = t.res.content;
            if (scope === 'global') {
                ctx.extensionSettings.regex = list;
                await ctx.saveSettingsDebounced?.();
            } else {
                const ch = charBy(a.card || ctx.characterId);
                ch.data.extensions = ch.data.extensions || {};
                ch.data.extensions.regex_scripts = list;
                await writeCardExtensions(ch.avatar, ext => { ext.regex_scripts = list; return ext; });
            }
            return { ok: true, scope, field: t.field, script: rx.scriptName || rx.id, replacements: t.res.replacements, preview };
        },
    },
    {
        name: 'entry.edit',
        kind: 'write',
        desc: '行级编辑世界书条目正文（DSH edit 语义）。按 comment 或 uid 定位条目，old_string 唯一匹配才改；命中多处 / 找不到时返回行号与最近似行。比整条重写好：改一行不会把 AI 写好的长条目重输一遍。',
        params: {
            book: 'string 必填，世界书名',
            comment: 'string 可选，条目名（与 uid 二选一）',
            uid: 'number 可选，条目 uid',
            old_string: 'string 必填',
            new_string: 'string 必填',
            replace_all: 'boolean 可选，默认 false',
            dry_run: 'boolean 可选，只算不写',
        },
        run: async a => {
            if (!a.book) throw new Error('entry.edit 需要 book');
            const got = await getEntries({ name: a.book, limit: 500 });
            const list = got.entries || [];
            let hit = null;
            if (a.uid !== undefined && a.uid !== null && a.uid !== '') hit = list.find(e => Number(e.uid) === Number(a.uid));
            if (!hit && a.comment) hit = list.find(e => String(e.comment || '') === String(a.comment)) || list.find(e => String(e.comment || '').indexOf(a.comment) >= 0);
            if (!hit) throw new Error(`世界书「${a.book}」里找不到条目（uid=${a.uid || '-'} comment=${a.comment || '-'}）`);
            const res = editText(hit.content, a.old_string, a.new_string, !!a.replace_all, `条目「${hit.comment}」`);
            if (!res.ok) return Object.assign({ book: a.book, uid: hit.uid, comment: hit.comment }, res);
            const preview = editPreview(hit.content, res.content, a.old_string, a.new_string);
            if (a.dry_run) return { ok: true, dry_run: true, book: a.book, uid: hit.uid, comment: hit.comment, replacements: res.replacements, preview };
            const out = await setEntry({ name: a.book, uid: hit.uid, comment: hit.comment, content: res.content });
            return { ok: true, book: a.book, uid: out.uid, comment: hit.comment, replacements: res.replacements, bytes: res.content.length, preview };
        },
    },
    {
        name: 'fe.spec',
        kind: 'read',
        desc: '前端/状态栏/脚本/条目四类「正确写法」规范（结构化返回，不是长文）。kind=beautify|structured|chat|floating 给单类，all 给总览：每类带上正则配置、必须保留的核心函数、真实踩过的坑（标签只包正文、0层卡静默生成参数、悬浮球禁止 window.top.document 等）。embed=true 时附正文美化/结构化数据两份标准模板原文（chat 模板太大，用 fe.chat 取）。写之前先读它，比事后返工便宜。',
        params: {
            kind: 'string 可选，beautify / structured / chat / floating / statusbar / script / entry / all（默认 all）',
            embed: 'boolean 可选，附模板原文（只对 beautify/structured 生效）',
        },
        run: async a => {
            const k = String(a.kind || 'all').toLowerCase();
            const out = { ok: true, kind: k };
            if (k === 'all' || k === 'frontend') out.frontend = FE_SPEC;
            if (k === 'all' || k === 'statusbar') out.statusbar = STATUSBAR_SPEC;
            if (k === 'all' || k === 'script') out.script = SCRIPT_SPEC;
            if (k === 'all' || k === 'entry') out.entry = ENTRY_SPEC;
            if (FE_SPEC.kinds[k]) out[k] = FE_SPEC.kinds[k];
            if (a.embed) {
                if (k === 'beautify' || k === 'all') out.template_beautify = FE_BEAUTIFY_BASE_HTML;
                if (k === 'structured' || k === 'all') out.template_structured = FE_STRUCTURED_BASE_HTML;
            }
            if (k === 'chat' && a.embed) out.note = '0 层卡模板 47KB，用 fe.chat 取（它会顺带写进世界书）';
            return out;
        },
    },
    {
        name: 'fe.audit',
        kind: 'read',
        desc: '前端 HTML 体检：查完整文档、核心函数是否被删、禁用标签、window.top.document、0层卡静默生成参数、正文美化/结构化各自的必需函数。html 不给就取卡里对应正则的 replaceString（正则名匹配「正文美化」/「面板」，或按 regex_id 指定）。返回 problems + fixes + notes，只读不写。',
        params: {
            kind: 'string 可选，beautify / structured / chat / floating（默认 chat）',
            html: 'string 可选，直接给 HTML',
            card: 'string 可选，头像文件名（从卡里正则取）',
            regex_id: 'string 可选，指定正则 id',
            regex_name: 'string 可选，按正则名包含匹配',
        },
        run: async a => {
            let kind = String(a.kind || '').toLowerCase();
            let html = String(a.html || '');
            let source = 'html 参数';
            if (!html) {
                const rs = scopedScripts(charBy(a.card || c().characterId));
                let hit = null;
                if (a.regex_id) hit = rs.find(r => r && r.id === a.regex_id);
                if (!hit && a.regex_name) hit = rs.find(r => r && String(r.scriptName || '').indexOf(a.regex_name) >= 0);
                if (!hit) hit = rs.find(r => r && r.markdownOnly && !r.promptOnly && String(r.findRegex || '').indexOf('StatusPlaceHolder') < 0);
                if (hit) { html = String(hit.replaceString || ''); source = `卡内正则「${hit.scriptName || hit.id}」`; }
            }
            // 没显式指定 kind 时按正则名 + 内容特征推断，否则会把 structured 面板按 0 层卡的口径误报
            if (!kind) kind = inferFrontendKind(a.regex_name || (a.html ? '' : ''), String(html || ''));
            const r = auditFrontend(html, kind);
            return Object.assign({ source, inferred: a.kind ? false : true }, r);
        },
    },
    {
        name: 'script.audit',
        kind: 'read',
        desc: '非 MVU 脚本体检：脚本位里混 HTML、裸 import z、window.top.document、把轮询当事件、iframe 里直接拿 TavernHelper 等崩点逐条查。给 card + id/name 读卡内脚本，或直接给 content。返回 problems + fixes + notes。',
        params: {
            card: 'string 可选，头像文件名（默认当前角色）',
            id: 'string 可选，脚本 id',
            name: 'string 可选，脚本名（包含匹配）',
            content: 'string 可选，直接给脚本文本',
            all: 'boolean 可选，体检卡内全部脚本（返回逐条结果）',
        },
        run: async a => {
            if (!a.content && a.all) {
                const scripts = ((charBy(a.card || c().characterId)?.data.extensions || {}).tavern_helper || {}).scripts || [];
                const items = scripts.map(x => {
                    const r = auditScript(String(x.content || ''), String(x.name || ''));
                    return { name: x.name || '', id: x.id || '', bytes: String(x.content || '').length, ok: r.ok, problems: r.problems, notes: (r.notes || []).length };
                });
                return {
                    card: a.card || '', total: items.length,
                    bad: items.filter(i => !i.ok).length,
                    problems: items.filter(i => !i.ok).map(i => `「${i.name}」` + i.problems.join('；')),
                    items,
                };
            }
            let content = String(a.content || '');
            let source = 'content 参数';
            let name = a.name || '';
            if (!content) {
                const scripts = ((charBy(a.card || c().characterId)?.data.extensions || {}).tavern_helper || {}).scripts || [];
                let hit = null;
                if (a.id) hit = scripts.find(x => x && x.id === a.id);
                if (!hit && a.name) hit = scripts.find(x => x && String(x.name || '').indexOf(a.name) >= 0);
                if (!hit) throw new Error('没给 content，也没在卡里找到对应脚本（传 id/name）');
                content = String(hit.content || '');
                name = hit.name || '';
                source = `卡内脚本「${name}」`;
            }
            const r = auditScript(content, name);
            return Object.assign({ source, name }, r);
        },
    },
    {
        name: 'entry.audit',
        kind: 'read',
        desc: '世界书条目体检（非 MVU 条目同样适用）：触发式没 keys=白写、常驻挂 keys、常驻被禁用、重名、正文混 HTML、{{…}} 未闭合、position/depth 语义错配。给 comment/uid 查单条，或 all=true 查整本。返回 problems + fixes + notes。',
        params: {
            book: 'string 必填，世界书名',
            comment: 'string 可选，条目名（包含匹配）',
            uid: 'number 可选，条目 uid',
            all: 'boolean 可选，整本体检',
        },
        run: async a => {
            if (!a.book) throw new Error('entry.audit 需要 book');
            const got = await getEntries({ name: a.book, limit: 500 });
            let list = got.entries || [];
            if (!a.all) {
                if (a.uid !== undefined && a.uid !== null && a.uid !== '') list = list.filter(e => Number(e.uid) === Number(a.uid));
                else if (a.comment) list = list.filter(e => String(e.comment || '').indexOf(a.comment) >= 0);
                else list = list.slice(0, 12);
            }
            const r = auditEntryList(list);
            return Object.assign({ book: a.book, scoped: !a.all }, r);
        },
    },
    {
        name: 'mvu.doctor',
        kind: 'read',
        desc: 'MVU 变量系统的逐环诊断，只读不写。查六件事：卡里有没有挂 MVU 本体（bundle 脚本）——注意 MVU 不需要装扩展，本体只是一条 import bundle.js 的卡内脚本、卡里有没有注册 zod 变量结构的脚本（registerMvuSchema）、7 条世界书条目齐不齐且 position/depth/order/constant 合不合规范、InitVar 里真有的变量与状态栏 HTML 里 getvar 引用的是否逐条对得上、写卡器那 6 条固定正则（含两条状态栏）是否落在卡上并开了闸、占位符是否只出现一次。返回 problems（坏在哪一环）+ fixes（按顺序照做）+ notes（不致命但对不上）。做卡做到「状态栏不显示」时先跑它，别自己猜。',
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

            // ① MVU 本体（bundle 脚本）。注意：写卡器**从来不需要装 MagVarUpdate 扩展**——
            // 它只是在卡的「酒馆助手」脚本位放一行 `import'https://testingcf.jsdelivr.net/gh/.../bundle.js';`，
            // 运行时由 jsdelivr 拉取。所以判据是「卡里有没有这一条」，不是「extensions/third-party 有没有目录」。
            const thEarly = (ch && ch.data && ch.data.extensions && ch.data.extensions.tavern_helper) || {};
            const earlyScripts = flatScripts(thEarly.scripts);
            const hasBundle = earlyScripts.some(x => String(x.id || '') === '961f366d-e403-45c2-8155-3d14ec86de53'
                || /MagVarUpdate|bundle\.js/.test(String(x.content || '')));
            if (!ch) {
                /* 没开卡由下面第 ② 项统一报，这里不重复 */
            } else if (!hasBundle) {
                problems.push('卡里没有 MVU 本体脚本（id 961f366d… 或内容含 bundle.js）：运行时没挂上，变量永远不动');
                fixes.push('用 mvu.runtime 写一份本体脚本（内容就是一行 import\'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js\';）。**不需要装 MagVarUpdate 扩展，也不要 extension.install** —— 写卡器就是这么做的');
            } else {
                notes.push('本体脚本已挂；bundle.js 由 jsdelivr 加载，加载不出来是网络或酒馆助手 iframe 的问题，不是「没装扩展」');
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
                mvu_bundle_script: hasBundle,
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
        desc: '按写卡器 v329.59 的口径验收一本书的 MVU：6 条本体（[InitVar]/更新规则/输出格式/输出格式强调/变量列表/<状态栏>占位符提醒，核心名匹配、兼容变体）是否存在+ 每条 position/depth/order/constant/enabled 是否合规范 + 内容特征是否齐（变量列表要 format_message_variable::stat_data、占位提醒要 StatusPlaceHolderImpl、InitVar 不能含 {{ 宏）+ ⑧ 状态栏两条正则是否就位 + 第 1 条 zod schema 脚本是否存在且没有裸 import z。返回 missing 清单与可直接照做的修法。写完 MVU 卡后必须跑一次，空 list 才算完成。',
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
            for (const spec of MVU_SPEC) {
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
                    if (/^\s*stat_data\s*:/.test(body)) issues.push('「[InitVar]初始变量」多套了一层 stat_data 根：变量会变成 stat_data.stat_data.X，schema 与状态栏都读不到。删掉这一行，下面的键整体左移两格');
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
                next: okAll ? '6 条本体 + 两份脚本 + 状态栏两条正则齐备，可开始写正文' : [
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
    {
        name: 'card.audit',
        kind: 'read',
        desc: '整卡体检（对照写卡器教科书卡）：一次查完 InitVar 多套 stat_data 根、schema 与 InitVar 顶层键不一致、z.number 未 coerce、状态栏 HTML 塞进世界书条目、触发式没 keys 白写、模板占位没按题材改写、6 条固定正则缺失或 placement/markdownOnly 配错、缺 MVU 本体或变量结构脚本。拿到别人的卡、自己写完卡、用户报「变量不动 / 状态栏不出来」时先跑这个，比逐项抽查快。只读，不改卡。',
        params: {
            card: 'string 可选，头像文件名（默认当前角色）',
            book: 'string 可选，指定世界书名（默认用卡绑定的那本）',
        },
        run: async a => {
            const ch = charBy(a.card);
            if (!ch) throw new Error('找不到角色卡' + (a.card ? `：${a.card}` : ''));
            // 卡里没内嵌世界书时，回落到这张卡绑定的书（写卡器产品形态：条目在外部 TestBook 里）
            const pack = JSON.parse(JSON.stringify(ch));
            const bookName = String(a.book || '') || (((ch.data && ch.data.extensions || {}).world) || '');
            if (!(pack.data && pack.data.character_book && (pack.data.character_book.entries || []).length) && bookName) {
                try {
                    const got = await getEntries({ name: bookName, limit: 500 });
                    pack.data = pack.data || {};
                    pack.data.character_book = { name: bookName, entries: got.entries || [] };
                } catch (e) { /* 书不存在就按空处理 */ }
            }
            const r = auditCardPack(pack);
            return Object.assign({ card: ch.avatar || '', name: ch.name || '', book: bookName || '' }, r);
        },
    },
];

export default TOOLS;
