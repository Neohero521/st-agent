import { getContext } from '../../../extensions.js';
import { MODULE, BRIDGE_ID, DEFAULT_SETTINGS, settings, abortController, running, bridgeOnline, generateOverride, messages, currentView, setSettings, setAbortController, setRunning, setBridgeOnline, setMessages, setCurrentView, setGenerateOverride } from './index-state.js';
import { ctx, loadSettings, saveSettings, pingBridge, getProfiles, generateRawFn, getGenerateRaw, serializeHistory, rawGenerate } from './index-boot.js';
import { typewrite, MODEL_FIELD, buildChatPayload, streamChatCompletion } from './index-stream.js';
import { buildSystemPrompt } from './index-prompt.js';
import { HIGH_RISK_PATTERNS, RISK_META, riskOf, batchLines, executeTool, summarizeArgs, briefArgs } from './index-risk.js';
import { runAgent } from './index-agent.js';
import { html, buildPanel, bindPanel } from './index-ui.js';
import { buildMenuEntry, togglePanel, setBusy, updateStatus, addLog, addStreamingDraft } from './index-ui2.js';
import { askPlan, askApprovalBatch, askApproval, submitTask, populateProfiles, syncSettingsUI } from './index-ui3.js';
import { registerChatTools } from './index-tools.js';
import { refreshBridgeState, initialize } from './index.js';
import { toolByName, toolsPrompt, activeTools } from './tools.js';
import { ADV_TOOLS, advToolByName, advToolsPrompt, helperInfo } from './adv-tools.js';

/* ------------------------------ 循环 ------------------------------ */

const TAG_TAB = ' \t\r\n';

function tryJson(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { /* 再试一次修好的 */ }
    try { return JSON.parse(repairJson(raw)); } catch { return null; }
}

/**
 * 从开标签的属性串里取 name。
 * 必须三种写法都认：name="x"、name='x'、name=x（模型在长上下文里很容易掉引号）。
 * 用 indexOf 扫而不用正则：少一层转义，也就少一处推上去被吞坏的机会。
 */
function pickName(attrs) {
    const low = String(attrs || '').toLowerCase();
    for (const q of ['"', "'"]) {
        let k = low.indexOf('name');
        while (k >= 0) {
            const before = k === 0 ? ' ' : low[k - 1];
            let p = k + 4;
            while (p < low.length && TAG_TAB.includes(low[p])) p++;
            if (TAG_TAB.includes(before) && low[p] === '=') {
                p++;
                while (p < low.length && TAG_TAB.includes(low[p])) p++;
                if (low[p] === q) {
                    const end = low.indexOf(q, p + 1);
                    if (end > p) {
                        const v = String(attrs).slice(p + 1, end).trim();
                        if (v) return v;
                    }
                }
            }
            k = low.indexOf('name', k + 4);
        }
    }
    // 无引号：name=world.list
    let k = low.indexOf('name');
    while (k >= 0) {
        const before = k === 0 ? ' ' : low[k - 1];
        let p = k + 4;
        while (p < low.length && TAG_TAB.includes(low[p])) p++;
        if (TAG_TAB.includes(before) && low[p] === '=') {
            p++;
            while (p < low.length && TAG_TAB.includes(low[p])) p++;
            let end = p;
            while (end < low.length && !TAG_TAB.includes(low[end]) && low[end] !== '>' && low[end] !== '/') end++;
            const v = String(attrs).slice(p, end).trim();
            if (v) return v;
        }
        k = low.indexOf('name', k + 4);
    }
    return '';
}

/** 找到一个开标签的 '>' 位置（返回 '>' 之后的下标，找不到返回 -1）
 *  必须跳过引号里的 '>'：属性值里带 '>'（例 data="a>b"）时，
 *  停在第一个 '>' 会把标签截断，后面整条调用跟着断。
 */
function headEndOf(src, from) {
    let q = '';
    for (let i = from; i < src.length; i++) {
        const ch = src[i];
        if (q) { if (ch === q) q = ''; continue; }
        if (ch === '"' || ch === "'") { q = ch; continue; }
        if (ch === '>') return i + 1;
    }
    return -1;
}

/**
 * 开/闭标签一律按"任意前缀 + call"认：<tool_call / <call_call / <callcall / <call。
 * 模型在生成时会写坏标签名（手机上实测过 <call_call>，等于把 call 重复了一个词），
 * 只认 <tool_call 的结果就是整段调用被当成正文摆出来、看着像卡死。
 */
const OPEN_CALL_RE = /<[A-Za-z_]{0,12}call(?=[\s>/])/gi;
const CLOSE_CALL_RE = /<\/[A-Za-z_]{0,12}call(?=[\s>])/gi;

function findOpenCall(src, from) {
    OPEN_CALL_RE.lastIndex = from;
    const m = OPEN_CALL_RE.exec(src);
    if (!m) return null;
    return { start: m.index, len: m[0].length };
}

function findCloseCall(src, from) {
    CLOSE_CALL_RE.lastIndex = from;
    const m = CLOSE_CALL_RE.exec(src);
    if (!m) return null;
    return { start: m.index, len: m[0].length };
}

/** 把 src 里所有 <xxx_call ...>body</xxx_call ...> 扫出来，返回 [{name, body, start, end}] */
function scanCallBlocks(src) {
    const out = [];
    let pos = 0;
    while (pos < src.length) {
        const open = findOpenCall(src, pos);
        if (!open) break;
        const headEnd = headEndOf(src, open.start + open.len);
        if (headEnd < 0) break;
        const attrs = src.slice(open.start + open.len, headEnd - 1);
        let close = findCloseCall(src, headEnd);
        // 正文里本身就可能写着 </tool_call>（写卡器脚本 / 正则内容常带这个串），
        // 那样会提前闭合、把参数 JSON 断在半路。若按这个闭合点切出来的 JSON 是不完整的，
        // 就继续往后找闭合，最多试 4 个；真找不到完整的还能退回"未闭合"分支。
        for (let tries = 0; close && tries < 4; tries++) {
            const cut = src.slice(headEnd, close.start).trim();
            if (!cut) break;
            if (cut[0] !== '{' && cut[0] !== '[') break;
            if (tryJson(cut)) break;
            const next = findCloseCall(src, close.start + close.len);
            if (!next) { close = null; break; }
            close = next;
        }
        const closeEnd = close ? headEndOf(src, close.start + close.len) : -1;
        if (closeEnd < 0) {
            // 未闭合：交给截断检测，这里只记录残块
            out.push({ name: pickName(attrs), body: src.slice(headEnd), start: open.start, end: src.length, unclosed: true });
            break;
        }
        out.push({
            name: pickName(attrs),
            body: src.slice(headEnd, close.start),
            start: open.start,
            end: closeEnd,
            unclosed: false,
        });
        pos = closeEnd;
    }
    return out;
}

/**
 * 从「给模型看的历史」和「界面正文」里剥掉调用/结果的原始标签。
 * 模型会把调用写成 <call_call ...>，也会自己伪造 <tool_result ok="true">
 * 装成工具已经回过话。这些串一旦留在上下文里，下一轮它照着坏格式继续写，
 * 越滚越歪——界面上看到的就是一串标签加上几句解释，活干不完。
 */
export function stripToolMarkup(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(/<[A-Za-z_]{0,12}call\b[^>]*>[\s\S]*?<\/[A-Za-z_]{0,12}call\s*>/gi, '');
    // 模型自己"写"出来的工具结果整块删掉：内容是它编的，留着会以为自己已经拿到了回执
    s = s.replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_result\s*>/gi, '');
    s = s.replace(/<[A-Za-z_]{0,12}call\b[^>]*>/gi, '');
    s = s.replace(/<\/[A-Za-z_]{0,12}call\s*>/gi, '');
    s = s.replace(/<\/?tool_result[^>]*>/gi, '');
    s = s.replace(/<\/?result\b[^>]*>/gi, '');
    return s.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 另一套工具调用语法：DeepSeek 系后端（以及部分 OpenAI 兼容网关）会把 tool_calls
 * 序列化成 DSML —— <|DSML|`invoke name="char.get"> … <|DSML|`parameter name="k">v …
 * 不认这套写法时，整段调用会被当成正文原样摆出来，表现就是"输出停在这里不动了"。
 */
function parseDsml(src) {
    const calls = [];
    const INV = /<[|｜][^<>]{0,40}?invoke\b([^>]*)>/gi;
    const invs = [];
    let m;
    while ((m = INV.exec(src)) !== null) {
        invs.push({ attrs: m[1] || '', start: m.index, end: INV.lastIndex });
    }
    for (let i = 0; i < invs.length; i++) {
        const cur = invs[i];
        const name = pickName(cur.attrs);
        if (!name) continue;
        const stop = i + 1 < invs.length ? invs[i + 1].start : src.length;
        const body = src.slice(cur.end, stop);
        const args = {};
        const PAR = /<[|｜][^<>]{0,40}?parameter\b([^>]*)>/gi;
        const ps = [];
        let p;
        while ((p = PAR.exec(body)) !== null) {
            const at = p[1] || '';
            const nm = pickName(at);
            // 没有 name 的一律不进列表：闭合标记 </<|DSML|`parameter> 里也可能出现 <|，
            // 一旦把它当成参数开标签，上一个参数的值就会被提前切断（文件名变成 "…png</"）。
            if (!nm) continue;
            ps.push({ attrs: at, name: nm, start: p.index, end: PAR.lastIndex });
        }
        for (let j = 0; j < ps.length; j++) {
            const key = ps[j].name;
            const vEnd = j + 1 < ps.length ? ps[j + 1].start : body.length;
            // 值到第一个 DSML 标记为止：从标记起整段丢弃（跨行），
            // 否则文件名/JSON 尾巴会带上 "…png</" 这类残渣。
            let val = String(body.slice(ps[j].end, vEnd)).replace(/<[\/<\s]*[|｜][\s\S]*$/, '').trim();
            if (!val) { args[key] = ''; continue; }
            // 没有 string="true" 标记时按字面量还原：布尔/数字参数用文本传过去会被工具判类型错
            if (!/string\s*=\s*["']?true/i.test(ps[j].attrs || '')) {
                if (/^(?:true|false)$/i.test(val)) { args[key] = val.toLowerCase() === 'true'; continue; }
                if (/^-?\d+(?:\.\d+)?$/.test(val)) { args[key] = Number(val); continue; }
            }
            const obj = tryJson(val);
            // 只有能解析成对象/数组时才当结构化参数，其余一律按原文（"true"、"1" 不该被改成布尔数字）
            args[key] = (obj && typeof obj === 'object') ? obj : val;
        }
        calls.push({ name, args, raw: src.slice(cur.start, stop) });
    }
    return calls;
}

export function parseToolCalls(text) {
    const src = String(text || '');
    const calls = [];

    // 0) DSML 风格（DeepSeek 系序列化）先认：不认的话后面会把整段当正文显示出去
    for (const call of parseDsml(src)) calls.push(call);

    // 1) <tool_call name=...>body</tool_call>：双引号 / 单引号 / 裸名都认
    let rest = src;
    for (const block of scanCallBlocks(src)) {
        if (!block.unclosed) {
            if (block.name) {
                calls.push(buildCall(block.name, block.body));
            } else {
                // 2) <tool_call>{"name":"x","arguments":{...}}</tool_call>
                const obj = tryJson(block.body);
                const name = obj && (obj.name || obj.tool);
                if (name) calls.push({ name, args: obj.arguments || obj.args || obj.parameters || {}, raw: src.slice(block.start, block.end) });
            }
        } else if (block.name) {
            // 未闭合：只有 body 像 JSON 时才当成"被切断的调用"，正文里提到标签不该算
            const tail = block.body.trim();
            if (tail === '' || tail[0] === '{' || tail[0] === '[') {
                calls.push(buildCall(block.name, tail));
            }
        }
        if (!block.unclosed) rest = rest.split(src.slice(block.start, block.end)).join(' ');
    }

    // 3) ```json {"tool": "...", "args": {...}} ```
    const fenced = rest.split('```');
    for (let i = 1; i < fenced.length; i += 2) {
        const chunk = fenced[i].replace(/^[ \t\r\n]*(?:json|JSON)[ \t\r\n]*/, '');
        if (chunk[0] !== '{') continue;
        const obj = tryJson(chunk);
        if (!obj) continue;
        const name = obj.tool || obj.name;
        const args = obj.args || obj.arguments || obj.parameters || {};
        if (name && (toolByName(name) || advToolByName(name))) calls.push({ name, args, raw: '```' + fenced[i] + '```' });
    }
    return calls;
}

/**
 * 修复模型常见的“JSON 字符串里带裸换行/制表符”问题，只在字符串上下文内转义。
 */
export function repairJson(raw) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (const ch of String(raw)) {
        if (escaped) { out += ch; escaped = false; continue; }
        if (ch === '\\') { out += ch; escaped = true; continue; }
        if (ch === '"') { inString = !inString; out += ch; continue; }
        if (inString) {
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') { continue; }
            if (ch === '\t') { out += '\\t'; continue; }
            if (ch < ' ') { out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'); continue; }
        }
        out += ch;
    }
    return out;
}

export function buildCall(name, rawArgs) {
    const trimmed = String(rawArgs || '').trim();
    if (!trimmed) return { name, args: {}, raw: '' };
    let parsed = null;
    let err = '';
    try {
        parsed = JSON.parse(trimmed);
    } catch (e) {
        try {
            parsed = JSON.parse(repairJson(trimmed));
        } catch (e2) {
            err = e2.message;
        }
    }
    if (!err) {
        // 参数必须是个对象：模型偶尔把参数写成数组或裸字符串，硬塞给工具只会静默改错东西，
        // 宁可这一条判失败、把错误回给模型让它重发。
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { name, args: parsed, raw: '' };
        }
        err = '参数不是 JSON 对象';
    }
    return { name, args: {}, parseError: err, raw: trimmed.slice(0, 200) };
}

export function extractFinal(text) {
    const src = String(text || '');
    const blocks = [];
    const re = /<final>([\s\S]*?)<\/final>/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
        const t = m[1].trim();
        if (t) blocks.push(t);
    }
    if (blocks.length) {
        // 模型有时把结论分两段写（第一段被切断、续写又补一段）。只取第一段会丢一半结论；
        // 后段只是前段的重复时也不要重复摆两遍。
        if (blocks.length === 1) return blocks[0];
        const uniq = [];
        for (const b of blocks) {
            if (uniq.some(u => u.includes(b))) continue;
            uniq.push(b);
        }
        return uniq.join(String.fromCharCode(10, 10));
    }
    // 没有闭合：说明这一轮被切在 final 中间。别把半句话吐成普通回复，
    // 至少把标签剥掉、把已经写出来的部分当结论显示（续写会在上层把它接完整）。
    const open = src.toLowerCase().lastIndexOf('<final>');
    if (open >= 0) {
        const tail = src.slice(open + 7).replace(/<\/final[^>]*>/i, '').trim();
        if (tail) return tail;
    }
    return null;
}

export function sumChars(list) {
    return list.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
}

export function compactHistory(list) {
    const cap = Number(settings.maxHistoryChars) || 24000;
    const arr = Array.isArray(list) ? list : [];
    if (sumChars(arr) <= cap) return arr;
    // ① 先把长条目压短：早期工具结果没必要一直占着窗口。
    //    最近 3 条一律不动——刚拿到的工具结果就是这一步判断的依据，截短等于让模型瞎猜。
    const compacted = arr.map((m, i) => {
        if (i <= 1) return m; // system + 首条任务
        if (i >= arr.length - 3) return m;
        if (typeof m.content !== 'string') return m;
        if (m.content.length <= 600) return m;
        return { ...m, content: m.content.slice(0, 400) + `\n…（早期结果已压缩，原 ${m.content.length} 字符）` };
    });
    if (sumChars(compacted) <= cap) return compacted;
    // ② 压完还超，就硬裁：system 必留，其余按「从最近往前」装到预算满为止。
    //    长会话（几十轮 + 每步 12k 的工具回执）不裁的话，每一步都会顶到模型窗口，
    //    表现就是频繁 400 / 半句截断，而不是"模型不想写"。
    const head = compacted[0] && compacted[0].role === 'system' ? [compacted[0]] : [];
    const body = compacted.slice(head.length);
    // system 本身就常占两万多字，不能拿总预算去减它——否则历史会被裁到只剩一条。
    // 给对话部分保底 8k 字符，够容纳最近几步的工具回执与结论。
    const bodyCap = Math.max(8000, cap - sumChars(head));
    const keep = [];
    let used = 0;
    for (let i = body.length - 1; i >= 0; i--) {
        const len = typeof body[i].content === 'string' ? body[i].content.length : 0;
        if (keep.length >= 2 && used + len > bodyCap) break;
        keep.unshift(body[i]);
        used += len;
    }
    if (keep.length < body.length) {
        // 交代一句被省掉的部分：不写的话模型会以为上下文凭空断了
        keep.unshift({ role: 'user', content: `（更早的 ${body.length - keep.length} 条上下文已省略，只为控住窗口）` });
    }
    return [...head, ...keep];
}

/* ---------------------- 截断检测与自动续写 ---------------------- */

/**
 * 粗估 token 数。中文一个字按 1.3 token、其他字符按 3.6 字符/token 算，
 * 宁可略高估：估高了最坏只是多问一次续写，估低了就会出现"半句话被当成结论"。
 */
export function estimateTokens(text) {
    const s = String(text ?? '');
    let cjk = 0;
    let other = 0;
    for (const ch of s) {
        const cp = ch.codePointAt(0) || 0;
        const isCjk = (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)
            || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x3000 && cp <= 0x303f);
        if (isCjk) cjk++;
        else other++;
    }
    return Math.round(cjk * 1.3 + other / 3.6);
}

/** 半句话的特征：结尾挂在这些符号上就说明话没说完 */
const DANGLING_TAIL = /[，,、；;：:（(<《「『“"—…·]$/;

/** 一句话收尾的标点：落在这些字符上，说明这句话本来就说完了 */
const SENTENCE_END = '。！？!?…；;：:」』”"）)】—';

/**
 * 判断这段文本是不是被输出上限切断了。
 * 只认三种证据，尽量不误伤正常结尾：
 *  1) 结构没闭合（tool_call / final / 代码块）—— 铁证；
 *  2) 几乎顶到 token 上限（>= 95%）；
 *  3) 用了大半预算且结尾悬挂在逗号、括号这类符号上。
 */
export function detectTruncation(text, maxTokens) {
    const full = String(text ?? '');
    if (!full.trim()) return { truncated: false, reason: '' };
    const low = full.toLowerCase();

    // ⓪ DSML 调用被切断：有 invoke 却没有 calls 收尾，说明整段断在半路
    if (/<[|｜]/.test(full) && /invoke\b/i.test(full) && !/(?:tool_)?calls\s*>\s*$/i.test(full.trimEnd())) {
        return { truncated: true, reason: 'DSML 调用未闭合' };
    }

    // ① 结构证据。这里只管"真的被切断的残块"：
    //    正文里解说 `<tool_call>` 这个标签（模型经常干）不该被当成半截调用，
    //    否则会触发没必要的续写，用户看到的就是同一段话被写两遍。
    for (const block of scanCallBlocks(full)) {
        if (block.unclosed) {
            const tail = block.body.trim();
            if (tail === '' || tail[0] === '{' || tail[0] === '[') {
                return { truncated: true, reason: 'tool_call 未闭合' };
            }
            continue;
        }
        const body = block.body.trim();
        if (!body) continue;
        const probe = buildCall(block.name || 'unknown', body);
        const msg = String(probe.parseError || '');
        if (probe.parseError && /end of json|unterminated|unexpected end|after json/i.test(msg)) {
            return { truncated: true, reason: 'JSON 参数被切断' };
        }
    }

    // ② final 没闭合，并且尾巴不是一句话的结尾
    if (low.indexOf('<final>') >= 0 && low.indexOf('</final>') < 0) {
        const after = full.slice(low.indexOf('<final>') + 7).trimEnd();
        if (after && !SENTENCE_END.includes(after.slice(-1))) {
            return { truncated: true, reason: 'final 未闭合' };
        }
    }

    // ③ 代码块开了一半
    const fences = (full.match(/^```/gm) || []).length;
    if (fences % 2 === 1) return { truncated: true, reason: '代码块未闭合' };

    // ④ 顶到上限 / 结尾悬挂
    const budget = Number(maxTokens) || 0;
    if (budget > 0) {
        const est = estimateTokens(full);
        if (est >= budget * 0.95) return { truncated: true, reason: `顶到 ${budget} token 上限` };
        if (est >= budget * 0.6 && DANGLING_TAIL.test(full.trimEnd())) {
            return { truncated: true, reason: '结尾悬挂' };
        }
    }
    return { truncated: false, reason: '' };
}

export const CONTINUE_HINT = '（上一条回复因输出长度上限被截断。请紧接中断处的最后一个字往下写，不要重复已写内容，不要加“继续”“接上”之类的过渡语，也不要重新开头。）';

/** 上一次续写是否只是把原文重复了一遍（模型有时会从头再写） */
function looksRepeated(base, chunk) {
    const tail = base.trimEnd().slice(-40);
    const head = String(chunk || '').trim().slice(0, 40);
    if (!tail || !head) return false;
    return tail.includes(head) || head.includes(tail);
}

/**
 * 截断就续写，直到内容结构闭合或达到次数上限。
 * 续写方式：把已生成的部分作为 assistant 消息喂回去，让它接着写 ——
 * 这比重试一次更强：连被切断的 JSON 参数也能补完整，而不是整段重来。
 */
export async function continueText(list, first, handlers = {}, maxTokens = 0, limit = 3) {
    let text = String(first ?? '');
    let rounds = 0;
    while (rounds < limit) {
        const probe = detectTruncation(text, maxTokens);
        if (!probe.truncated) break;
        rounds++;
        handlers.onNote?.(`回复被截断（${probe.reason}），自动续写第 ${rounds} 次`);
        const next = await stepGenerate([
            ...list,
            { role: 'assistant', content: text },
            { role: 'user', content: CONTINUE_HINT },
        ], {
            onText: chunk => handlers.onText?.(text + chunk),
            onReasoning: handlers.onReasoning,
        });
        const chunk = String(next.text || '');
        if (!chunk.trim() || looksRepeated(text, chunk)) break;
        text += chunk;
    }
    return { text, rounds, truncated: detectTruncation(text, maxTokens).truncated };
}

/**
 * 生成一层：统一返回 { text, reasoning, streamed, truncated, reason }。
 * 优先级：调试 override → 指定连接配置（流式）→ 酒馆当前 chat completion（真流式）
 *        → 回退 generateRaw 全文 + 打字机补放。
 */
export async function stepGenerate(list, handlers = {}) {
    const onText = handlers.onText;
    const onReasoning = handlers.onReasoning;
    // 每个出口都带一次截断体检：上层据此决定续写还是当成完整结论
    const finish = (text, reasoning, streamed) => {
        const t = String(text ?? '');
        return { text: t, reasoning, streamed, ...detectTruncation(t, settings.maxTokens) };
    };

    if (typeof generateOverride === 'function') {
        const text = await generateOverride(list);
        await typewrite(text, onText, abortController?.signal);
        return finish(text, '', false);
    }

    const c = ctx();
    const svc = c.ConnectionManagerRequestService;
    const profileId = settings.profileId;

    if (profileId && svc) {
        const request = await svc.sendRequest(profileId, list, settings.maxTokens, {
            stream: true,
            extractData: true,
            includePreset: false,
            includeInstruct: false,
            signal: abortController?.signal,
        });
        if (typeof request !== 'function') {
            const text = request?.content || '';
            await typewrite(text, onText, abortController?.signal);
            return finish(text, request?.reasoning || '', false);
        }
        let text = '';
        let reasoning = '';
        for await (const chunk of request()) {
            if (abortController?.signal?.aborted) break;
            if (chunk?.text) { text = chunk.text; onText?.(text); }
            const r = chunk?.state?.reasoning;
            if (r && r !== reasoning) { reasoning = r; onReasoning?.(r, false); }
        }
        if (reasoning) onReasoning?.(reasoning, true);
        return finish(text, reasoning, true);
    }

    // 酒馆「API 连接」= 当前配置。只有 chat completion 后端（main_api=openai）才有真流式，
    // kobold / novel / textgen 这些走 generateRaw + 打字机。
    if (settings.streamMode !== 'off' && c.mainApi === 'openai' && c.ChatCompletionService) {
        try {
            const streamed = await streamChatCompletion(list, { onText, onReasoning });
            return finish(streamed.text, streamed.reasoning, streamed.streamed);
        } catch (error) {
            if (abortController?.signal?.aborted) throw error;
            const message = String(error?.message || error);
            // 通道级损坏（Tauri / 老 WebView 的 locked stream）→ 记住本环境不可用，不再反复踩
            if (/pipeThrough|locked stream|ReadableStream/i.test(message)) {
                settings.streamMode = 'off';
                saveSettings();
                syncSettingsUI();
                addLog('error', '该环境的流式通道不可用，已自动关闭流式（设置里可手动重开）');
            } else {
                addLog('error', `流式失败，回退非流式：${message}`);
            }
        }
    }

    const text = await rawGenerate(list);
    await typewrite(text, onText, abortController?.signal);
    return finish(text, '', false);
}
