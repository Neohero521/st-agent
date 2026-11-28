/**
 * 游玩污染体检（v1.42）
 *
 * 起因：装了插件之后「所有卡」的回复都变味、Agent 写出来的卡更是直接不回复。
 * 排查后确认不是插件改了 ST 的 prompt，而是三条「从卡逃逸到全局」的通道：
 *   ① regex.upsert 在没有当前角色卡（群聊 / 欢迎页）时会退回全局 —— 一张卡的美化正则
 *      从此对所有卡生效；
 *   ② inject.set 写的是 ST 的 extensionPrompts，那是全聊天共享的常驻注入，写一次
 *      所有卡每轮都带；
 *   ③ 世界里常驻的超长条目（把 47KB 前端 HTML 写进条目）—— 每轮 prompt 白背几万字符，
 *      小上下文直接爆掉，表现就是「AI 不回复」。
 * 这个库只读盘点 + 定点清理，不改 ST 的对话流程。
 */

import { c } from './adv-lib-core.js';
import { charBy, scopedScripts, scopedAllowed, upsertScoped } from './adv-lib-regex.js';
import { loadBook, setEntry } from './adv-lib-world.js';

/** 明显只该属于某张卡的正则名 */
const SINGLE_CARD_HINT = /^\[美化\]|^\[不发送\]|MVU|状态栏|变量更新|思维链|界面/;

/** 明显是 MVU 卡专用的匹配串 */
const SINGLE_CARD_FIND = /StatusPlaceHolderImpl|UpdateVariable|stat_data|status_current_variable/;

/** 常驻条目正文超过这个长度就算「进 prompt 太贵」 */
const BIG_ENTRY = 8000;

function len(v) {
    if (v == null) return 0;
    if (typeof v === 'string') return v.length;
    if (typeof v === 'object') return String(v.value ?? v.content ?? '').length;
    return String(v).length;
}

/** 把 extensionPrompts 里的每一项摊平（ST 存 {value, position, depth, role, scan}） */
function readPrompts() {
    const raw = c().extensionPrompts || {};
    return Object.entries(raw).map(([key, v]) => ({
        key,
        chars: len(v),
        position: typeof v === 'object' ? v.position : undefined,
        depth: typeof v === 'object' ? v.depth : undefined,
        role: typeof v === 'object' ? v.role : undefined,
        preview: String((typeof v === 'object' ? (v.value ?? '') : v) || '').slice(0, 80),
    }));
}

/** 全局正则风险判定（只判「会连累别的卡」的情形，不判一般写法） */
function globalRegexRisk(r) {
    if (!r || r.disabled) return '';
    const find = String(r.findRegex || '');
    const rep = String(r.replaceString || '');
    const out = [];
    if (r.promptOnly && !r.markdownOnly && rep === '') out.push('发给模型前把命中内容整段删除，命中面一宽就是「模型看不到正文」');
    if (rep.length > 4000) out.push(`replaceString ${rep.length} 字符，任何卡命中都会被整段换成它`);
    if (SINGLE_CARD_FIND.test(find)) out.push('匹配串是 MVU 卡专用的，挂全局会连别的卡一起改');
    if (SINGLE_CARD_HINT.test(String(r.scriptName || ''))) out.push('从名字看是单卡用的（美化/状态栏/变量/界面），应该挂在卡里');
    if (find && find.length <= 8 && !find.startsWith('/')) out.push('findRegex 极短又没有 /…/ 包裹，很容易命中普通正文');
    return out.join('；');
}

/**
 * 只读盘点：谁在污染所有卡、这张卡为什么回复不正常。
 * @param {object} ch 角色卡（可空，空了就只查全局面）
 * @param {{book?:string}} opts
 */
export async function auditPlayState(ch, opts = {}) {
    const ctx = c();
    const problems = [];
    const fixes = [];
    const notes = [];

    /* ① 全局正则：影响所有卡 */
    const globalList = Array.isArray(ctx.extensionSettings?.regex) ? ctx.extensionSettings.regex : [];
    const globals = globalList.map(r => ({
        name: r.scriptName || '',
        findRegex: String(r.findRegex || '').slice(0, 70),
        replaceChars: String(r.replaceString || '').length,
        markdownOnly: !!r.markdownOnly,
        promptOnly: !!r.promptOnly,
        disabled: !!r.disabled,
        placement: r.placement,
        risk: globalRegexRisk(r),
    }));
    const risky = globals.filter(g => g.risk);
    if (risky.length) {
        problems.push(`全局正则 ${risky.length} 条会连累所有卡：${risky.map(r => `「${r.name}」`).join('、')}。全局正则对所有角色生效，单卡美化/状态栏/隐藏标记应当挂在卡里`);
        fixes.push('chat.fix {"action":"global-regex-to-card"} 把它们迁到当前卡（或 action:"disable-global-regex" 先停用）');
    }

    /* ② 全局注入：extensionPrompts 是跨卡的 */
    const prompts = readPrompts();
    const injects = prompts.filter(p => p.chars > 0);
    const mine = injects.filter(p => /st-agent|sta/i.test(p.key));
    if (mine.length) {
        problems.push(`有 ${mine.length} 条常驻注入会进每一张卡的提示词：${mine.map(p => `${p.key}(${p.chars} 字符)`).join('、')}`);
        fixes.push('chat.fix {"action":"clear-inject"} 清掉；inject.set 只在用户明确要临时注入时用');
    }
    for (const p of injects.filter(p => !mine.includes(p))) {
        notes.push(`其他扩展的注入 ${p.key}（${p.chars} 字符）也在每轮生效，不是本插件写的`);
    }

    /* ③ 全局世界书：globalSelect 里的书对所有卡扫描 */
    const pu = ctx.powerUser || {};
    const globalBooks = Array.isArray(pu.world_info?.globalSelect) ? pu.world_info.globalSelect.filter(Boolean) : [];
    if (globalBooks.length) {
        notes.push(`全局启用世界书：${globalBooks.join('、')} —— 这些书对每一张卡都会扫描；只想给一张卡用就改绑到卡/聊天`);
    }
    for (const name of globalBooks) {
        const books = await bigEntriesOf(name);
        if (books.big.length) {
            problems.push(`全局书「${name}」里有 ${books.big.length} 条常驻超长条目（最大 ${books.max} 字符）：所有卡的每一轮提示词都要背这些内容，小上下文会直接爆`);
            fixes.push(`把「${name}」从全局书单移出（world.setGlobal 或 chat.fix {"action":"unselect-book","book":"${name}"}），或删掉那条超长常驻条目`);
        }
    }

    /* ④ 当前聊天绑定的书 */
    const chatBook = ctx.chatMetadata?.world_info || '';
    const books = [];
    for (const name of [chatBook, opts.book].filter(Boolean)) {
        if (books.some(b => b.book === name)) continue;
        books.push(await bigEntriesOf(name));
    }

    /* ⑤ 当前卡本身 */
    const card = ch ? {
        avatar: ch.avatar,
        name: ch.name,
        firstMesHasPlaceholder: /StatusPlaceHolderImpl/.test(String(ch.first_mes || '')),
        systemPromptChars: String(ch.system_prompt || '').length,
        postHistoryChars: String(ch.post_history_instructions || '').length,
        depthPromptChars: String(ch.data?.extensions?.depth_prompt?.prompt || '').length,
        scopedRegex: scopedScripts(ch).length,
        scopedAllowed: scopedAllowed(ch),
        descriptionChars: String(ch.description || '').length,
    } : null;

    if (card) {
        if (card.systemPromptChars > 2000) {
            problems.push(`卡的 system_prompt 有 ${card.systemPromptChars} 字符：它会顶掉 ST 自己的 system 指令，模型容易不按角色说话`);
            fixes.push('把大段设定挪回 description / 世界书，system_prompt 只留一两句行为约束');
        }
        if (card.postHistoryChars > 2000) notes.push(`post_history_instructions 有 ${card.postHistoryChars} 字符：紧贴最后一条消息，太长会把对话尾部的引导挤掉`);
        if (card.depthPromptChars > 2000) notes.push(`depth_prompt 注入 ${card.depthPromptChars} 字符，每轮都在对话深处插一段`);
        if (card.scopedRegex && card.scopedAllowed === false) {
            problems.push(`卡里有 ${card.scopedRegex} 条正则但正则总闸没开：这些正则一条都不跑（表现是「卡里的美化/清理完全没效果」）`);
            fixes.push('regex.upsert 重写一次会自动开闸，或到「正则 → Scoped」勾上这张卡');
        }
        if (!card.firstMesHasPlaceholder && card.scopedRegex) {
            notes.push('开场白没有 <StatusPlaceHolderImpl/>：第一轮回复之前状态栏位置会是空的');
        }
    }

    /* ⑥ 估算每轮真正进 prompt 的字符量 */
    let promptChars = 0;
    for (const b of books) promptChars += b.constantChars;
    promptChars += injects.reduce((n, p) => n + p.chars, 0);
    if (card) promptChars += card.descriptionChars + card.systemPromptChars + card.postHistoryChars + card.depthPromptChars;

    if (promptChars > 12000) {
        problems.push(`每轮固定进提示词约 ${promptChars} 字符（世界书常驻 + 注入 + 卡字段）：手机端小上下文模型很容易直接超限，表现是「AI 不回复」或回复截断`);
        fixes.push('先砍世界书里的超长常驻条目（尤其 HTML），HTML 一律改挂正则 replaceString');
    } else if (promptChars > 6000) {
        notes.push(`每轮固定进提示词约 ${promptChars} 字符，偏重但还能跑`);
    }

    return {
        ok: problems.length === 0,
        chat_book: chatBook,
        card,
        globals: { count: globals.length, risky: risky.length, items: globals },
        injects: { count: injects.length, items: injects },
        global_books: globalBooks,
        books,
        prompt_chars_estimate: promptChars,
        problems,
        fixes,
        notes,
    };
}

/** 读一本书的常驻条目体积（只算 constant=true 且没被禁用的） */
async function bigEntriesOf(name) {
    let entries = [];
    try {
        const data = await loadBook(name);
        entries = Object.values(data.entries || {});
    } catch {
        return { book: name, error: '读不到这本世界书', total: 0, constantChars: 0, big: [], max: 0 };
    }
    const live = entries.filter(e => e && e.constant === true && e.disable !== true && e.enabled !== false);
    const chars = live.reduce((n, e) => n + String(e.content || '').length, 0);
    const big = live.filter(e => String(e.content || '').length > BIG_ENTRY)
        .map(e => ({ comment: e.comment || '', chars: String(e.content || '').length }))
        .sort((a, b) => b.chars - a.chars);
    return { book: name, total: entries.length, constant_count: live.length, constantChars: chars, big, max: big.length ? big[0].chars : 0 };
}

/* ------------------------------ 清理 ------------------------------ */

/**
 * 定点清理。默认 dryRun：只报「会改什么」，不落盘。
 * action:
 *   global-regex-to-card  把全局正则迁到当前卡（names 为空 = 只迁判定危险的）
 *   disable-global-regex  停用全局正则（names 为空 = 只停危险的）
 *   clear-inject          清掉本插件写的常驻注入（names 指定则只清这些 key）
 *   unselect-book         把一本世界书从全局书单移出（需 book 或 names[0]）
 *   disable-big-entry     禁用一本世界书里的超长常驻条目（默认所有 >8000 字符的常驻条目）
 */
export async function fixPlayState(action, opts = {}) {
    const ctx = c();
    const dry = opts.dryRun !== false;
    const names = Array.isArray(opts.names) && opts.names.length ? opts.names.map(String) : null;
    const ch = charBy(opts.card || ctx.characterId);

    if (action === 'clear-inject') {
        const prompts = ctx.extensionPrompts || {};
        const keys = names || Object.keys(prompts).filter(k => /st-agent|sta/i.test(k));
        if (!keys.length) return { ok: true, action, changed: 0, note: '没有本插件写的常驻注入' };
        if (!dry) {
            for (const k of keys) delete prompts[k];
            ctx.saveSettingsDebounced?.();
        }
        return { ok: true, action, dry_run: dry, removed: keys };
    }

    if (action === 'disable-big-entry') {
        const book = String(opts.book || (names && names[0]) || '');
        if (!book) throw new Error('需要 book');
        const data = await loadBook(book);
        const entries = Object.values(data.entries || {});
        const hit = entries.filter(e => {
            if (String(e.content || '').length <= BIG_ENTRY) return false;
            if (names) return names.includes(String(e.comment || ''));
            return e.disable !== true && e.constant === true;
        });
        if (!hit.length) return { ok: true, action, dry_run: dry, book, changed: 0, note: '这本没有超长常驻条目' };
        if (!dry) {
            for (const e of hit) await setEntry({ name: book, uid: e.uid, enabled: false });
        }
        return {
            ok: true, action, dry_run: dry, book,
            disabled: hit.map(e => ({ comment: e.comment || '', uid: e.uid, chars: String(e.content || '').length })),
            note: '只是禁用（内容还在，随时能开回来）；HTML 要真正渲染请用 fe.regex 挂成卡内正则，条目只留一行输出标记',
        };
    }

    if (action === 'unselect-book') {
        const book = String(opts.book || (names && names[0]) || '');
        if (!book) throw new Error('需要 book');
        const pu = ctx.powerUser || {};
        pu.world_info = pu.world_info || {};
        const list = Array.isArray(pu.world_info.globalSelect) ? pu.world_info.globalSelect : [];
        if (!list.includes(book)) return { ok: true, action, dry_run: dry, note: `「${book}」本来就不在全局书单里`, list };
        if (!dry) {
            pu.world_info.globalSelect = list.filter(x => x !== book);
            ctx.saveSettingsDebounced?.();
            const el = document.querySelector('#world_info');
            if (el) el.value = pu.world_info.globalSelect.join(',');
        }
        return { ok: true, action, dry_run: dry, book, before: list, after: (dry ? list.filter(x => x !== book) : pu.world_info.globalSelect) };
    }

    // 正则相关
    const gl = Array.isArray(ctx.extensionSettings?.regex) ? ctx.extensionSettings.regex : [];
    let targets = gl.filter(r => (names ? names.includes(String(r.scriptName || '')) : !!globalRegexRisk(r)));
    if (!targets.length) return { ok: true, action, dry_run: dry, changed: 0, note: '没有需要处理的全局正则' };

    if (action === 'disable-global-regex') {
        if (!dry) {
            for (const r of targets) r.disabled = true;
            ctx.saveSettingsDebounced?.();
        }
        return { ok: true, action, dry_run: dry, disabled: targets.map(r => r.scriptName) };
    }

    if (action === 'global-regex-to-card') {
        if (!ch) throw new Error('没有目标角色卡：迁到卡里要先指定 card，或显式只做 disable-global-regex');
        const moved = [];
        for (const r of targets) {
            if (!dry) {
                const keepId = String(r.id || '');
                await upsertScoped(ch, Object.assign(
                    keepId ? { id: keepId } : {},
                    {
                    scriptName: r.scriptName,
                    findRegex: r.findRegex,
                    replaceString: r.replaceString,
                    placement: Array.isArray(r.placement) ? r.placement : [2],
                    disabled: !!r.disabled,
                    markdownOnly: !!r.markdownOnly,
                    promptOnly: !!r.promptOnly,
                    runOnEdit: !!r.runOnEdit,
                    substituteRegex: Number(r.substituteRegex) || 0,
                    }));
            }
            moved.push(r.scriptName);
        }
        if (!dry) {
            ctx.extensionSettings.regex = gl.filter(r => !targets.includes(r));
            ctx.saveSettingsDebounced?.();
        }
        return { ok: true, action, dry_run: dry, card: ch.avatar, moved, opened: dry ? null : scopedAllowed(ch) };
    }

    throw new Error(`不认识的 action：${action}`);
}
