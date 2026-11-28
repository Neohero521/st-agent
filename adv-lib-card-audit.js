/**
 * 整卡体检（对照写卡器教科书卡：陈天爱那种「MVU / 状态栏 / 变量全对」的卡）
 *
 * 沈曼卿那类 Agent 卡的典型错法，逐条都能在这里查出来：
 *  1. InitVar 多套一层 stat_data 根 → 变量变成 stat_data.stat_data.X，schema 对不上
 *  2. 状态栏 HTML 同时塞进世界书条目和正则 → 条目那份 selective=true + keys 空，永远不触发，纯占提示词
 *  3. schema 与 InitVar 顶层键不一致 / 缺 z.coerce.number + prefault / 结尾缺分号
 *  4. 变量更新规则不是写卡器标准原文（缺 <UpdateVariable> 硬性要求）
 *  5. 骨架条目占位词没按题材改写（东方玄幻 · 慢热 · 日常向）
 *  6. 6 条固定正则不全 / placement 不是 [2] / markdownOnly 与 promptOnly 配错
 */

const MVU_FIXED_REGEX = [
    { id: 'd668c8a6-fa6a-444d-a5d6-8f68b73a3c36', name: '仅格式思维链', want: { markdownOnly: false, promptOnly: true, runOnEdit: false } },
    { id: '5bb4b588-23ca-4564-8df5-882104eff764', name: '只发送最新2楼的变量更新', want: { markdownOnly: false, promptOnly: true, runOnEdit: false } },
    { id: '6fb572ae-a9ea-436d-9779-ad100f1ff7f5', name: '[美化]变量完成', want: { markdownOnly: true, promptOnly: false, runOnEdit: false } },
    { id: 'bf1b7441-5cf1-426d-bd6c-911332be9923', name: '[美化]变量更新中', want: { markdownOnly: true, promptOnly: false, runOnEdit: false } },
    { id: 'mvu-status-hide', name: '[不发送]隐藏状态栏标记', want: { markdownOnly: false, promptOnly: true, runOnEdit: false } },
    { id: 'mvu-status-bar', name: '[美化]MVU状态栏', want: { markdownOnly: true, promptOnly: false, runOnEdit: true } },
];

const ENTRY_ROLES = [
    { key: 'initvar', name: '[InitVar]初始变量', test: c => /InitVar|初始变量/.test(c) },
    { key: 'rule', name: '[mvu_update]变量更新规则', test: c => /变量更新规则/.test(c) },
    { key: 'format', name: '[mvu_update]变量输出格式', test: c => /变量输出格式/.test(c) && !/强调/.test(c) },
    { key: 'emph', name: '[mvu_update]变量输出格式强调', test: c => /变量输出格式强调|输出格式强调/.test(c) },
    { key: 'varlist', name: '变量列表', test: c => /^[\[【<]?(变量列表|变量当前状态)/.test(c) || c.trim() === '变量列表' },
    { key: 'placeholder', name: '<状态栏>占位符提醒', test: c => /占位符提醒|占位提醒/.test(c) },
    { key: 'statusbar', name: '状态栏', test: c => /^[\[【<]?状态栏[\]】>]?$/.test(c.trim()) },
];

const PLACEHOLDER_TEXT = [
    '<待填',
    '东方玄幻 · 慢热 · 日常向',
    '以一句定调（题材 + 节奏 + 情绪）',
    '这里写主题（如 白娅·人际关系）',
    '两到四条确定的事实，写具体',
    '这条现在为什么相关',
    '玩家提到哪些词时它应该被想起',
    '力量/科技/规则的上限写一句，防止越写越飘',
];

/** InitVar 顶层键（非缩进行 `键:`） */
export function initVarTopKeys(text) {
    const out = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!line || /^\s/.test(line)) continue;
        const m = line.match(/^([^#\-][^:]*):\s*$/);
        if (m) out.push(m[1].trim());
    }
    return out;
}

/** schema 顶层键（z.object({ 之下缩进 2 的 `键: z.`） */
export function schemaTopKeys(text) {
    const s = String(text || '');
    const i = s.search(/z\.object\s*\(\s*\{/);
    if (i < 0) return [];
    const rest = s.slice(s.indexOf('{', i) + 1);
    const out = [];
    for (const line of rest.split(/\r?\n/)) {
        if (/^\}\s*[),]/.test(line)) break;
        const m = line.match(/^ {2}([^:\s]+)\s*:/);
        if (m) out.push(m[1]);
    }
    return out;
}

/** InitVar 体检 */
export function auditInitVar(text) {
    const body = String(text || '');
    const problems = [];
    const fixes = [];
    const notes = [];
    if (!body.trim()) return { ok: false, problems: ['[InitVar]初始变量 是空的'], fixes: ['用 mvu.build 或 wcInitVarYaml 生成'], notes, keys: [] };
    if (/^\s*stat_data\s*:/.test(body)) {
        problems.push('[InitVar] 多套了一层 stat_data 根：MVU 初始化后变量会变成 stat_data.stat_data.X，schema 与状态栏都读不到');
        fixes.push('删掉第一行 stat_data:，把它下面的键整体左移两个空格（顶层就是变量根，例如「陈天爱:」或「世界:」）');
    }
    if (/\{\{/.test(body)) problems.push('[InitVar] 含 {{...}} 酒馆宏：初始化时被替换成乱码');
    if (/^\s*</.test(body)) problems.push('[InitVar] 看起来是 HTML/XML，不是 YAML');
    const keys = initVarTopKeys(body);
    if (!keys.length) notes.push('没解析到顶层键：确认每个根对象写的是「名字:」且下一层缩进 2 空格');
    const concrete = (body.match(/: [ \t]*(?!null|0|false|~|\[\]|\{\})[^\n]{1,20}$/gm) || []).length;
    if (concrete > 3) notes.push(`${concrete} 个字段写成了具体剧情值（地址/衣着/时间等）：开局会被锁死在这段状态里，确认不是想让开场白决定`);
    const nulls = (body.match(/:\s*null\s*$/gm) || []).length;
    if (nulls) notes.push(`${nulls} 个字段初始值是 null：配合 z.string().nullable().prefault(null) 才合法，数值字段不要写 null`);
    return { ok: problems.length === 0, problems, fixes, notes, keys };
}

/** schema 体检（并对 InitVar 的顶层键） */
export function auditSchema(text, initKeys = []) {
    const s = String(text || '');
    const problems = [];
    const fixes = [];
    const notes = [];
    if (!s.trim()) return { ok: false, problems: ['没有 zod schema 脚本（变量结构）'], fixes: ['用 mvu.schema 写入，或照抄教科书卡的 schema 骨架'], notes, keys: [] };
    if (/import\s*\{[^}]*\bz\b[^}]*\}\s*from\s*['"]zod['"]/.test(s)) {
        problems.push("裸 import { z } from 'zod'：z 在 MVU 环境是全局，这行会直接崩");
        fixes.push('删掉这行 import');
    }
    if (!/registerMvuSchema\s*\(/.test(s)) {
        problems.push('没有 registerMvuSchema(Schema)：schema 写了但没注册，等于没有结构校验');
        fixes.push("结尾补 $(() => { registerMvuSchema(Schema); });");
    }
    if (/z\.number\s*\(\s*\)/.test(s)) {
        problems.push('用了 z.number()：模型常把数值写成字符串（"85"），会校验失败；教科书卡一律 z.coerce.number()');
        fixes.push('改成 z.coerce.number().transform(v => _.clamp(v, 0, 100)).prefault(0)');
    }
    if (!/\.prefault\s*\(/.test(s)) {
        problems.push('没有 .prefault()：InitVar 缺字段时整个对象会校验失败，变量直接不动');
        fixes.push('每个叶子补 .prefault(null) / .prefault(0)，每个子对象补 .prefault({})');
    }
    const keys = schemaTopKeys(s);
    if (initKeys.length && keys.length) {
        const onlyInit = initKeys.filter(k => keys.indexOf(k) < 0);
        const onlySchema = keys.filter(k => initKeys.indexOf(k) < 0);
        if (onlyInit.length || onlySchema.length) {
            problems.push(`schema 顶层键与 InitVar 不一致：InitVar 多 [${onlyInit.join('、') || '无'}]，schema 多 [${onlySchema.join('、') || '无'}]`);
            fixes.push('两边顶层键必须一一对应（InitVar 的根对象 = schema 的 z.object 键）；先修 InitVar 的 stat_data 层，再对齐 schema');
        }
    }
    if (/export const Schema\s*=/.test(s) && !/\}\s*\)\s*;/.test(s)) notes.push('Schema 结尾可能缺分号（}) → });）');
    if (!/z\.object\s*\(/.test(s)) notes.push('没看到 z.object：确认 Schema 是 zod 对象');
    return { ok: problems.length === 0, problems, fixes, notes, keys };
}

/** 条目集合体检（MVU 七条 + 白写 + HTML 进条目 + 占位残留） */
export function auditEntries(entries, opts = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const problems = [];
    const fixes = [];
    const notes = [];
    const hasStatusBarRegex = opts.hasStatusBarRegex === true;
    const roles = {};
    for (const e of list) {
        const c = String(e.comment || e.name || '');
        const body = String(e.content || '');
        const selective = e.selective === true;
        const constant = e.constant === true;
        const keys = Array.isArray(e.key) ? e.key : (Array.isArray(e.keys) ? e.keys : []);
        const enabled = e.disable === true ? false : (e.enabled === false ? false : true);

        for (const r of ENTRY_ROLES) if (!roles[r.key] && r.test(c)) roles[r.key] = e;

        // 白写：触发式但没 keys
        if (!constant && selective && keys.length === 0 && e.disable !== true) {
            problems.push(`「${c}」是触发式但没有 keys：永远进不了提示词，等于白写`);
            fixes.push(`给「${c}」补 keys（专名/地点/动作词 3~5 个），或改 constant=true 常驻`);
        }
        // 状态栏 HTML 进条目
        const looksHtml = /<(div|style|table|section)\b/i.test(body) && body.length > 400;
        if (looksHtml && /状态栏/.test(c)) {
            problems.push(`「${c}」把 ${body.length} 字符状态栏 HTML 塞进了世界书条目：HTML 属于正则 replaceString，条目这份既不生效又白占提示词预算`);
            fixes.push(hasStatusBarRegex
                ? '这条状态栏正则已经存在：直接清掉该条目（或改成「只输出 <StatusPlaceHolderImpl/>」的说明）'
                : '先用 mvu.statusbar 把 HTML 写进卡内正则 + 占位提醒，再清掉这个条目');
        } else if (looksHtml) {
            notes.push(`「${c}」正文含 HTML 标签（${body.length} 字符）：如果是要渲染的面板，应该走正则`);
        }
        // 模板占位残留
        for (const p of PLACEHOLDER_TEXT) {
            if (body.indexOf(p) >= 0) {
                problems.push(`「${c}」还是模板占位原文（「${p.slice(0, 18)}」）：没按题材改写，模型会照着「东方玄幻」写`);
                fixes.push('把占位换成这张卡自己的题材/人物/规则，别整段照抄骨架');
                break;
            }
        }
        // 变量更新规则：必须真的教模型怎么输出更新块（而不是罗列字段结构）
        if (/变量更新规则/.test(c)) {
            const hasCmd = body.indexOf('<UpdateVariable') >= 0 || body.indexOf('JSONPatch') >= 0;
            const looksSchema = /type\s*:\s*(number|string|boolean|array|object)/.test(body) || /range\s*:\s*\d/.test(body);
            if (!hasCmd && looksSchema) {
                problems.push(`「${c}」写成了变量结构定义（type/range/check）：这是 zod schema 的活，模型读完仍不知道要输出 <UpdateVariable> 块，变量永远不动`);
                fixes.push('拆开：字段类型/范围写进 zod schema；这条只写「每轮末尾必须输出 <UpdateVariable> + 绝对路径 / 增减幅度 / 何时才变」');
            } else if (!hasCmd) {
                problems.push(`「${c}」没有提到 <UpdateVariable> 或 JSONPatch：模型不会真的输出变量块`);
                fixes.push('补一段「每次回复末尾必须输出 <UpdateVariable></UpdateVariable>」并给出绝对路径示例');
            }
        }
        // 变量列表
        if (/变量列表|变量当前状态/.test(c) && body.indexOf('format_message_variable::stat_data') < 0) {
            problems.push(`「${c}」缺 {{format_message_variable::stat_data}}：变量值不会显示给模型`);
            fixes.push('用 mvu.build 重建变量列表条目（含 --- 与 status_current_variable 包裹）');
        }
        // 占位提醒
        if (/占位符提醒|占位提醒/.test(c) && body.indexOf('StatusPlaceHolderImpl') < 0) {
            problems.push(`「${c}」缺 <StatusPlaceHolderImpl/>：模型不知道该输出占位符`);
            fixes.push('用 mvu.build 重建该条，或直接从教科书卡复制');
        }
        if (!enabled) notes.push(`「${c}」是禁用状态：写卡器模板里 InitVar / 输出格式强调 本来就是 enabled=false（InitVar 由 MVU 直接读，不进提示词），不用当成问题`);
    }
    // 七条齐全性
    const missing = ENTRY_ROLES.filter(r => !roles[r.key] && !(r.key === 'statusbar' && hasStatusBarRegex)).map(r => r.name);
    if (missing.length) {
        problems.push(`MVU 必备条目缺失：${missing.join('、')}`);
        fixes.push('用 mvu.build 一次性补齐（它会强制 position/depth/order/constant），不要一条条手写');
    }
    if (roles.statusbar && hasStatusBarRegex) {
        notes.push('「状态栏」条目和状态栏正则同时存在：条目那份应当清空或删除，只留占位提醒');
    }
    return { ok: problems.length === 0, problems, fixes, notes, roles: Object.keys(roles) };
}

/** 正则集合体检（6 条固定正则 + 配置项） */
export function auditRegexes(regexes) {
    const list = Array.isArray(regexes) ? regexes : [];
    const problems = [];
    const fixes = [];
    const notes = [];
    const found = {};
    for (const r of list) {
        const id = String(r.id || '');
        const named = MVU_FIXED_REGEX.find(x => x.id === id || String(r.scriptName || '').indexOf(x.name) >= 0);
        if (named) found[named.id] = r;
    }
    const missing = MVU_FIXED_REGEX.filter(x => !found[x.id]).map(x => x.name);
    if (missing.length) {
        problems.push(`MVU 固定正则缺 ${missing.length} 条：${missing.join('、')}`);
        fixes.push('用 mvu.statusbar 一次性补齐 6 条（缺一条就有一段流程不生效）');
    }
    for (const spec of MVU_FIXED_REGEX) {
        const r = found[spec.id];
        if (!r) continue;
        const diff = [];
        const placement = Array.isArray(r.placement) ? r.placement : [];
        if (placement.length !== 1 || Number(placement[0]) !== 2) diff.push(`placement ${JSON.stringify(placement)}→[2]`);
        if (r.markdownOnly !== spec.want.markdownOnly) diff.push(`markdownOnly ${r.markdownOnly}→${spec.want.markdownOnly}`);
        if (!!r.promptOnly !== spec.want.promptOnly) diff.push(`promptOnly ${!!r.promptOnly}→${spec.want.promptOnly}`);
        if (!!r.runOnEdit !== spec.want.runOnEdit) diff.push(`runOnEdit ${!!r.runOnEdit}→${spec.want.runOnEdit}`);
        if (diff.length) {
            problems.push(`正则「${spec.name}」配置不合规范：${diff.join('，')}`);
            fixes.push(`用 mvu.statusbar 重写这条，会强制成 ${JSON.stringify(spec.want)}`);
        }
        if (spec.id === 'mvu-status-bar') {
            const repl = String(r.replaceString || '');
            if (!/```html/.test(repl)) {
                problems.push('状态栏正则的 replaceString 没有 ```html 围栏：酒馆助手按 fence 建 iframe，裸 HTML 不渲染');
                fixes.push('replaceString 用 ```html 开头 + ``` 结尾（wrapHtml 会自动加）');
            }
            if (repl.length < 600) notes.push(`状态栏正则 replaceString 只有 ${repl.length} 字符：确认 HTML 完整（教科书卡约 8000）`);
        }
    }
    return { ok: problems.length === 0, problems, fixes, notes, found: Object.keys(found) };
}


/** InitVar 的变量树路径（用于和状态栏 getvar 的路径比对） */
export function yamlPaths(text) {
    const paths = new Set();
    const stack = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const m = line.match(/^(\s*)([^:#\s][^:]*):\s*(.*)$/);
        if (!m) continue;
        const indent = m[1].length;
        const key = m[2].trim();
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        const parent = stack.length ? stack[stack.length - 1].key : '';
        const full = parent ? parent + '.' + key : key;
        paths.add(full);
        stack.push({ indent, key: full });
    }
    return paths;
}

/**
 * 状态栏 HTML 体检（对比教科书卡：真 JS 渲染 + getAllVariables + 事件驱动 + 路径存在）
 * 最狠的一条：正则 replaceString 不执行 EJS，写 <% getvar() %> 会原样显示成源码。
 */
export function auditStatusBar(repl, initText) {
    const s = String(repl || '');
    const problems = [];
    const fixes = [];
    const notes = [];
    if (!s.trim()) return { ok: false, problems: ['状态栏正则 replaceString 是空的'], fixes: [], notes, hits: 0, total: 0 };

    if (/<%[\s\S]*?%>/.test(s)) {
        problems.push('状态栏 replaceString 里用了 EJS 模板语法 <% %>：**正则替换不执行 EJS**，玩家看到的是 <%- getvar(…) %> 源码。状态栏必须是自执行 JS（$(...) 里 getAllVariables 后逐字段填 DOM）');
        fixes.push('删掉所有 <% %>，改成 <!DOCTYPE html> + <script> 里 $(async () => { await waitGlobalInitialized("Mvu"); ... getAllVariables().stat_data ... }) + eventOn(VARIABLE_UPDATE_ENDED, render)');
    }
    if (/StatusPlaceHolderImpl/.test(s)) {
        problems.push('状态栏 replaceString 里又出现 <StatusPlaceHolderImpl/>：这是被替换的那个占位符本身，替换结果里再留一个会二次触发/露出文字');
        fixes.push('删掉 replaceString 内部的占位符，只留渲染后的 HTML');
    }
    if (!/\$\s*\(/.test(s) && !/<script/i.test(s)) {
        notes.push('状态栏没有 $( / <script>：不是可执行的渲染页，只会是一段静态 DOM');
    }
    if (!/VARIABLE_UPDATE_ENDED|eventOn|Mvu\.events/.test(s)) {
        notes.push('状态栏没有监听 VARIABLE_UPDATE_ENDED：变量更新后不会刷新，要等下一次整楼重渲染');
    }
    if (!/getAllVariables|getVariables/.test(s)) {
        notes.push('状态栏没有走 getAllVariables：只能硬读固定键，改字段名就整块空白');
    }
    if (!/^(\s*)```html/.test(s) && !/<!DOCTYPE/i.test(s)) {
        notes.push('状态栏 replaceString 既没有 ```html 围栏也没有 <!DOCTYPE html>：酒馆助手可能不建 iframe');
    }

    // 路径存在性：状态栏读的 stat_data.X 必须真的在 InitVar 树里
    const tree = yamlPaths(initText);
    const roots = [...new Set([...tree].map(p => p.split('.')[0]))];
    const reqs = [];
    for (const m of s.matchAll(/stat_data\.([A-Za-z0-9_\u4e00-\u9fa5.]+)/g)) reqs.push(m[1]);
    const uniq = [...new Set(reqs)];
    const bad = [];
    for (const r of uniq) {
        const ok = roots.some(root => r === root || r.indexOf(root + '.') === 0) && (tree.has(r) || [...tree].some(p => p.indexOf(r + '.') === 0));
        if (!ok) bad.push(r);
    }
    if (uniq.length && bad.length === uniq.length) {
        problems.push(`状态栏读的 ${uniq.length} 个路径在 InitVar 里一个都不存在（例如 ${bad.slice(0, 3).join('、')}）：整块状态栏会是空的/默认值`);
        fixes.push('让两边同名同层：InitVar 顶层根 = 状态栏 stat_data.<根> 的第一段（如「陈天爱」「世界」），不要一边平铺一边多套人物层');
    } else if (bad.length) {
        problems.push(`状态栏有 ${bad.length}/${uniq.length} 个路径在 InitVar 里不存在：${bad.slice(0, 5).join('、')}`);
        fixes.push('按 InitVar 的实际键名改状态栏里的 getvar 路径');
    }
    return { ok: problems.length === 0, problems, fixes, notes, hits: uniq.length - bad.length, total: uniq.length, bad: bad.slice(0, 8) };
}

/** 整卡体检：条目 + 正则 + 脚本 + InitVar/schema 联动 */
export function auditCardPack(pack) {
    const data = (pack && pack.data) || pack || {};
    const ext = data.extensions || {};
    const th = ext.tavern_helper || {};
    const scripts = Array.isArray(th.scripts) ? th.scripts : [];
    const regexes = Array.isArray(ext.regex_scripts) ? ext.regex_scripts : [];
    const book = data.character_book || {};
    const entries = Array.isArray(book.entries) ? book.entries : [];

    const initEntry = entries.find(e => /InitVar|初始变量/.test(String(e.comment || '')));
    const schemaScript = scripts.find(s => String(s.id || '') === 'mvu-schema' || /变量结构/.test(String(s.name || '')));
    const runtimeScript = scripts.find(s => String(s.id || '') === '961f366d-e403-45c2-8155-3d14ec86de53' || String(s.name || '') === 'MVU');

    const init = auditInitVar(initEntry ? initEntry.content : '');
    const schema = auditSchema(schemaScript ? schemaScript.content : '', init.keys);
    const hasStatusBarRegex = regexes.some(r => String(r.id || '') === 'mvu-status-bar');
    const ents = auditEntries(entries, { hasStatusBarRegex });
    const regs = auditRegexes(regexes);
    const sbRegex = regexes.find(r => String(r.id || '') === 'mvu-status-bar');
    const sb = sbRegex ? auditStatusBar(sbRegex.replaceString, initEntry ? initEntry.content : '') : { ok: true, problems: [], fixes: [], notes: [], hits: 0, total: 0 };

    const levels = { init, schema, statusbar: sb, entries: ents, regexes: regs };
    const problems = [];
    const fixes = [];
    const notes = [];
    for (const [k, r] of Object.entries(levels)) {
        for (const p of r.problems || []) problems.push(`[${k}] ${p}`);
        for (const f of r.fixes || []) if (fixes.indexOf(f) < 0) fixes.push(f);
        for (const n of r.notes || []) notes.push(`[${k}] ${n}`);
    }
    if (!runtimeScript) {
        problems.push('[scripts] 缺 MVU 本体脚本（id 961f366d…）：只写 schema 不挂本体，变量永远不动');
        fixes.push('用 mvu.runtime 写本体（content 只有一行 import，带 6 个隐藏按钮）');
    }
    if (!schemaScript) {
        problems.push('[scripts] 缺「变量结构」脚本：没有结构可校验，开局就报错');
        fixes.push('用 mvu.schema 写入 zod schema');
    }
    const stats = {
        entries: entries.length,
        regexes: regexes.length,
        scripts: scripts.length,
        initVarKeys: init.keys.length,
        schemaKeys: schema.keys.length,
        statusBarEntryHtml: entries.some(e => /状态栏/.test(String(e.comment || '')) && /<(div|style)/i.test(String(e.content || ''))),
        hasStatusBarRegex,
        statusBarPathHits: `${sb.hits}/${sb.total}`,
    };
    return {
        ok: problems.length === 0,
        problems,
        fixes,
        notes,
        stats,
        detail: { init, schema, entries: ents, regexes: regs },
    };
}
