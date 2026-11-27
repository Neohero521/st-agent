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

/** 找到一个开标签的 '>' 位置（返回 '>' 之后的下标，找不到返回 -1） */
function headEndOf(src, from) {
    for (let i = from; i < src.length; i++) {
        if (src[i] === '>') return i + 1;
    }
    return -1;
}

/** 把 src 里所有 <tool_call ...>body</tool_call ...> 扫出来，返回 [{name, body, start, end}] */
function scanCallBlocks(src) {
    const out = [];
    const low = src.toLowerCase();
    let pos = 0;
    while (pos < low.length) {
        const open = low.indexOf('<tool_call', pos);
        if (open < 0) break;
        const headEnd = headEndOf(src, open + 10);
        if (headEnd < 0) break;
        const close = low.indexOf('</tool_call', headEnd);
        const closeEnd = close < 0 ? -1 : headEndOf(src, close + 11);
        if (closeEnd < 0) {
            // 未闭合：交给截断检测，这里只记录残块
            out.push({ name: pickName(src.slice(open + 10, headEnd - 1)), body: src.slice(headEnd), start: open, end: src.length, unclosed: true });
            break;
        }
        out.push({
            name: pickName(src.slice(open + 10, headEnd - 1)),
            body: src.slice(headEnd, close),
            start: open,
            end: closeEnd,
            unclosed: false,
        });
        pos = closeEnd;
    }
    return out;
}

export function parseToolCalls(text) {
    const src = String(text || '');
    const calls = [];

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
    try {
        return { name, args: JSON.parse(trimmed), raw: '' };
    } catch (e) {
        try {
            return { name, args: JSON.parse(repairJson(trimmed)), raw: '' };
        } catch (e2) {
            return { name, args: {}, parseError: e2.message, raw: trimmed.slice(0, 200) };
        }
    }
}

export function extractFinal(text) {
    const src = String(text || '');
    const m = /<final>([\s\S]*?)<\/final>/i.exec(src);
    if (m) return m[1].trim();
    // 没有闭合：说明这一轮被切在 final 中间。别把半句话吐成普通回复，
    // 至少把标签剥掉、把已经写出来的部分当结论显示（续写会在上层把它接完整）。
    const open = src.toLowerCase().indexOf('<final>');
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
    if (sumChars(list) <= cap) return list;
    const compacted = list.map((m, i) => {
        if (i <= 1) return m; // system + 首条任务
        if (typeof m.content !== 'string') return m;
        if (m.content.length <= 600) return m;
        return { ...m, content: m.content.slice(0, 400) + `\n…（早期结果已压缩，原 ${m.content.length} 字符）` };
    });
    return compacted;
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
