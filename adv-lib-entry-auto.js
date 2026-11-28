/**
 * 世界书条目自动配置（照抄写卡器 inferEntryConfig + _deriveEntryKeys + 模板优先链）
 *
 * 写卡器原文（v329.59 8373–8645）：
 *  · inferEntryConfig：按 comment/正文关键词推断 probability / sticky / cooldown / delay / position / order / constant
 *  · _deriveEntryKeys：剥装饰括号 → 剥 <标签> → "·"切分 → 正文前 100 字抽 2~6 字中文词 → 停用词过滤 → 上限 8
 *  · 蓝灯(constant=true) 与向量化不派生 keys
 *  · 模板（ENTRY_TEMPLATES）优先于推断：MVU 规范条目一律走模板 meta
 */

const STOP_WORDS = new Set(['的', '是', '有', '我', '你', '他', '她', '它', '在', '和', '了', '与', '及', '个', '相关', '条目', '内容', '设定']);

/**
 * 写卡器原版只过滤「整个词等于虚词」，于是正文里会抽出「白娅是镇上的」「性格冷淡但会」这种跨虚词片段，
 * 作为触发词永远命不中。这里加一条片段级过滤：片段里只要夹了虚词字符就判为非名词性片段。
 * 过滤后不足 2 个才回退到未过滤结果，保证不会把条目派生到空。
 */
const FUNCTION_CHARS = /[的是在有和了与我你他她它您咱但并或者因所把被让给对从向于]/;
function looksNominal(seg) {
    if (!seg) return false;
    if (FUNCTION_CHARS.test(seg)) return false;
    return true;
}

const BODY_HEAD_STOP = /^(姓名|身份|外貌|性格|背景|关系|人际关系|物品|地点|时间|年龄|特征|爱好|特长|家庭|称呼|位置|心情|智慧|魅力|体质|状态|好感度|好感|当前|内容|说明|描述|定义|介绍|概要|摘要|标签|以上|例如|比如|如果|因为|所以|但是|并且|或者|不是|还是|这是|一个|一种|一类|一下|一些|一起)$/;

const DERIVE_HEAD_CHARS = 100;
const DERIVE_MAX = 8;

/** 剥最外层装饰括号（⟦⟧【】「」『』［］《》〈〉()[]{}），最多两层 */
export function stripOuterBrackets(s) {
    if (!s) return '';
    let r = String(s).trim();
    const pairs = [['⟦', '⟧'], ['【', '】'], ['「', '」'], ['『', '』'], ['［', '］'], ['《', '》'], ['〈', '〉'], ['(', ')'], ['[', ']'], ['{', '}']];
    for (let iter = 0; iter < 2; iter++) {
        let matched = false;
        for (const [L, R] of pairs) {
            if (r.length >= 4 && r.charAt(0) === L && r.charAt(r.length - 1) === R) {
                r = r.slice(1, -1).trim();
                matched = true;
                break;
            }
        }
        if (!matched) break;
    }
    return r;
}

/** 照抄 inferEntryConfig：只给建议，不强行 constant */
export function inferEntryConfig(comment, content) {
    const cfg = {};
    const cmt = String(comment || '');
    const body = String(content || '');
    const c = cmt + '\n' + body.slice(0, 800);

    if (/极低概率|千分之一|百万分之一|几乎不可能/.test(c)) {
        cfg.probability = 5; cfg.useProbability = true;
    } else if (/低概率|小概率|稀有|偶尔|万里挑一|极少数|罕见/.test(c)) {
        cfg.probability = 20; cfg.useProbability = true;
    } else if (/中概率|有时|时常|偶尔会/.test(c)) {
        cfg.probability = 50; cfg.useProbability = true;
    }

    const stickyM = c.match(/持续\s*(\d+)\s*(?:楼|条|轮)/);
    if (stickyM) cfg.sticky = parseInt(stickyM[1], 10);
    const cdM = c.match(/冷却\s*(\d+)/);
    if (cdM) cfg.cooldown = parseInt(cdM[1], 10);
    const delayM = c.match(/延迟\s*(\d+)/);
    if (delayM) cfg.delay = parseInt(delayM[1], 10);

    if (/世界观|世界设定|总纲|meta规则/.test(cmt)) {
        cfg.position = 0;
        cfg.order = cfg.order || 80;
    } else if (/人物|角色|主角|NPC|势力|地点/.test(cmt)) {
        cfg.position = 1;
        cfg.order = cfg.order || 100;
    } else if (/当前|剧情|进度|任务|此刻|实时|本轮/.test(cmt)) {
        cfg.position = 4;
        cfg.order = cfg.order || 150;
    } else {
        cfg.position = 0;
        cfg.order = cfg.order || 100;
    }

    if (/示例|对话示例|示范|sample|开场范例/.test(cmt)) {
        cfg.position = 5;
        cfg.order = cfg.order || 100;
    }
    if (/作者注|旁白|meta|注记/.test(cmt)) {
        cfg.position = 2;
        cfg.order = cfg.order || 100;
    }
    if (/出口|outlet|注入点/.test(cmt)) {
        cfg.position = 7;
        cfg.order = cfg.order || 100;
    }

    // 常驻智能推断：系统条目/底层规则 → 常驻；具体实体 → 随词触发
    if (/InitVar|初始变量|更新规则|输出格式|变量当前状态|变量列表|占位符提醒|状态栏|变量更新/.test(cmt)) {
        cfg.constant = true;
    } else if (/世界观|世界设定|总纲|底层规则|基础设定|核心设定|人设|角色设定|背景故事|重要规则|必须遵守|始终生效|不可违反/.test(c)) {
        cfg.constant = true;
    } else if (/随词触发|触发词|偶尔|随机|特定场景|NPC|对话|示例|道具|事件|地点|场景/.test(c)) {
        cfg.constant = false;
    }
    return cfg;
}

/** 照抄 _deriveEntryKeys：只对非常驻条目派生；蓝灯返回空 */
export function deriveEntryKeys(comment, options = {}) {
    if (!comment) return [];
    if (options.constant === true) return [];
    const content = String(options.content || '');
    let stripped = stripOuterBrackets(comment);
    // 剥 [分类] / <标签> 前缀（照写卡器 _entryCommentCore）：[角色]艾琳 → 艾琳
    let prev = null;
    while (prev !== stripped) {
        prev = stripped;
        stripped = stripped.replace(/^\[[^\]]*\]\s*/, '').replace(/^<[^>]*>\s*/, '').trim();
    }
    const m = stripped.match(/^<([^>]+)>\s*([\s\S]*)$/);
    const namePart = (m ? m[2] : stripped).trim();
    const candidates = [];

    if (namePart) {
        namePart.split(/[·\/,，、\-\\]+/).forEach(seg => {
            const s = seg.trim();
            if (!s) return;
            if (/[\u4e00-\u9fa5A-Za-z0-9]{2,}/.test(s) && !STOP_WORDS.has(s)) candidates.push(s);
        });
    }

    // 先按标点断句再取片段：避免跨句拼出无意义长串
    const head = content.slice(0, DERIVE_HEAD_CHARS);
    const clauses = head.split(/[，。、；：！？\n\r（）()「」『』\s]+/).filter(Boolean);
    const strict = [];
    const loose = [];
    const re = /[\u4e00-\u9fa5]{2,6}|[A-Za-z][A-Za-z0-9_]{1,15}/g;
    for (const clause of clauses) {
        re.lastIndex = 0;
        let mm;
        while ((mm = re.exec(clause)) !== null) {
            const w = mm[0];
            if (STOP_WORDS.has(w)) continue;
            if (BODY_HEAD_STOP.test(w)) continue;
            if (loose.indexOf(w) < 0) loose.push(w);
            if (looksNominal(w) && strict.indexOf(w) < 0) strict.push(w);
        }
    }
    const pool = strict.length >= 1 ? strict : loose;
    // 名字段已覆盖的更长片段直接丢：名字里有「断桥之夜」就不用再派生「断桥之夜发生」
    const nameSeeds = candidates.slice();
    for (const w of pool) {
        if (candidates.indexOf(w) >= 0) continue;
        if (nameSeeds.some(n => n && n !== w && w.indexOf(n) === 0)) continue;
        candidates.push(w);
        if (candidates.length >= DERIVE_MAX) break;
    }
    if (!candidates.length && namePart) candidates.push(namePart);

    const uniq = [];
    for (const c of candidates) {
        const v = String(c).trim();
        if (!v || v.length > 24) continue;
        if (uniq.indexOf(v) < 0) uniq.push(v);
        if (uniq.length >= DERIVE_MAX) break;
    }
    return uniq;
}

/**
 * 一次算出条目的完整配置：
 * ① 命中模板（世界元数据 / 角色边界 / 禁止项 / 统一输出格式 / 自定义条目 / MVU 各条）→ 模板 meta 优先
 * ② 否则用 inferEntryConfig 推断
 * ③ keys：常驻为空，否则派生（也接受显式 keys）
 * ④ overrides 覆盖（用户明确指定时永远赢）
 */
export function planEntry(comment, content = '', opts = {}) {
    const cmt = String(comment || '').trim();
    const body = String(content || '');
    const notes = [];
    const templateMeta = opts.templateMeta || null;
    const inferred = inferEntryConfig(cmt, body);
    const base = Object.assign({}, inferred, templateMeta || {});
    if (templateMeta) notes.push('meta 来自 templates（写卡器规范条目），推断只用于补缺');

    const constant = (opts.constant !== undefined) ? !!opts.constant : (base.constant === true);
    base.constant = constant;
    base.selective = base.selective === undefined ? !constant : base.selective;
    base.position = Number(base.position === undefined ? 0 : base.position);
    base.depth = Number(base.depth === undefined ? (base.position === 4 || base.position === 2 ? 4 : 0) : base.depth);
    base.order = Number(base.order === undefined ? 100 : base.order);
    base.enabled = base.enabled === undefined ? true : !!base.enabled;

    let keys = [];
    if (Array.isArray(opts.keys) && opts.keys.length) {
        keys = opts.keys.map(String).filter(Boolean).slice(0, DERIVE_MAX);
        notes.push('keys 用调用方显式给的');
    } else if (opts.deriveKeys === false) {
        notes.push('按规范不派生 keys（写卡器原版这类条目 keys 就是空，靠玩家填触发词或手动改常驻）');
    } else if (!constant) {
        keys = deriveEntryKeys(cmt, { constant: false, content: body });
        if (keys.length) notes.push(`keys 由触发词派生（名字切分 + 正文前 100 字，实际上限 8，本次 ${keys.length} 个）：写卡器原版也是启发式，建议人工删掉不像专名的长片段，留 3~5 个`);
        else notes.push('派生不出 keys：这条会永远不触发，给显式 keys 或改 constant');
    } else {
        notes.push('常驻条目不派生 keys（写卡器蓝灯规则）');
    }
    if (body.indexOf('<%') >= 0) notes.push('正文含 EJS 分隔符：确认是有意执行');
    if (/^\[|^</.test(cmt)) notes.push('条目名带 [分类]/<标签> 前缀：写卡器允许，判重按完整名');

    const meta = {
        position: base.position,
        depth: base.depth,
        order: base.order,
        constant: constant,
        selective: base.selective,
        enabled: base.enabled,
    };
    for (const k of ['probability', 'useProbability', 'sticky', 'cooldown', 'delay', 'use_regex']) {
        if (base[k] !== undefined && base[k] !== null) meta[k] = base[k];
    }
    for (const k of Object.keys(opts.overrides || {})) meta[k] = opts.overrides[k];

    return { comment: cmt, keys, meta, source: templateMeta ? 'template' : 'inferred', notes, inferred };
}

/** 非 MVU 的常驻骨架条目正文（写卡器风格：YAML 中文，短、可直接被模型理解） */
export const ENTRY_BODIES = {
    世界元数据: `---
世界元数据:
  风格基调: 以一句定调（题材 + 节奏 + 情绪），例如 东方玄幻 · 慢热 · 日常向
  时间流速: 每轮约 1 小时（按剧情需要调整）
  语言风格: 中文；多写具体动作与感官细节，少用抽象形容词
  描写约束: 每段 3~6 句；对话占三分之一以上；不写大段心理旁白
  世界底线: 力量/科技/规则的上限写一句，防止越写越飘`,

    角色边界: `---
角色边界:
  视角: 只扮演 {{char}} 与 NPC；不替 {{user}} 决定、不写 {{user}} 的台词
  知情: {{char}} 只知道亲眼所见或被明确告知的事，不知道读者视角，也不知道变量数值
  主动性: 每轮至少推进一个具体动作或一个可回应的提议，不空转、不复述
  记忆: 记住已发生的事实与承诺，前后矛盾时要让角色自己察觉异常`,

    禁止项: `---
禁止项:
  不得: 代替 {{user}} 说话或行动；无过渡地跳时间/跳场景；凭空新增重要人物；输出 Markdown 标题与代码块；复述设定原文
  冲突处理: 与前文矛盾时，以最近一次已发生的情节为准
  越界处理: 遇到无法继续的情形，让角色停下并提出选择，不要自行编造结局`,

    统一输出格式: `---
统一输出格式:
  每轮结构: 正文（3~6 段）→ 变量更新块（若启用 MVU）→ 状态栏占位符（若启用状态栏）
  标点约定: 动作与神态用全角括号（），对话用「」，内心独白单独成行
  禁止: 在正文里解释规则、写"（作为 AI）"、输出提示词原文或设定清单`,

    状态栏: `---
状态栏:
  占位符: 每次回复末尾单独一行输出 <StatusPlaceHolderImpl/>
  位置: 正文之后，变量更新块之后；不要包在代码块里
  禁止: 不在条目里写 HTML/CSS（状态栏 HTML 由正则渲染，用 mvu.preview 或 fe.regex 落盘）
  空白: 占位符前后各留一个空行，避免与正文粘连`,

    自定义条目: `---
条目: 这里写主题（如 白娅·人际关系）
  要点:
    - 两到四条确定的事实，写具体，不写"可能/或许"
  与当前剧情的关系:
    - 这条现在为什么相关
  可触发场景:
    - 玩家提到哪些词时它应该被想起`,
};

export const NONMVU_ENTRY_KINDS = Object.keys(ENTRY_BODIES);

/** 给 kind 取骨架；kind=custom 时用自定义条目骨架 + 主题替换 */
export function entryBody(kind, opts = {}) {
    const k = String(kind || '').trim();
    const body = ENTRY_BODIES[k];
    if (body) return body;
    if (k === 'custom') {
        return String(ENTRY_BODIES['自定义条目']).replace('这里写主题（如 白娅·人际关系）', opts.topic || opts.comment || '主题');
    }
    throw new Error(`未知条目骨架：${kind}（可选 ${NONMVU_ENTRY_KINDS.join(' / ')} / custom）`);
}
