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

export function parseToolCalls(text) {
    const calls = [];
    let rest = String(text || '');

    // 1) <tool_call name="x">{...}</tool_call>
    const re = /<tool_call\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/tool_call>/gi;
    let m;
    while ((m = re.exec(rest))) {
        calls.push(buildCall(m[1], m[2]));
    }
    rest = rest.replace(re, '');

    // 2) <tool_call>{"name":"x","arguments":{...}}</tool_call>
    const re2 = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
    while ((m = re2.exec(rest))) {
        try {
            const obj = JSON.parse(m[1]);
            const name = obj.name || obj.tool;
            const args = obj.arguments || obj.args || obj.parameters || {};
            if (name) calls.push({ name, args, raw: m[0] });
        } catch { /* ignore */ }
    }
    rest = rest.replace(re2, '');

    // 3) ```json {"tool": "...", "args": {...}} ```
    const re3 = /```(?:json)?\s*(\{[\s\S]*?"(?:tool|name)"[\s\S]*?\})\s*```/gi;
    while ((m = re3.exec(rest))) {
        try {
            const obj = JSON.parse(m[1]);
            const name = obj.tool || obj.name;
            const args = obj.args || obj.arguments || obj.parameters || {};
            if (name && (toolByName(name) || advToolByName(name))) calls.push({ name, args, raw: m[0] });
        } catch { /* ignore */ }
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
    const m = /<final>([\s\S]*?)<\/final>/i.exec(text);
    if (m) return m[1].trim();
    return null;
}

export function sumChars(list) {
    return list.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
}

export function compactHistory(list) {
    if (sumChars(list) <= settings.maxHistoryChars) return list;
    const compacted = list.map((m, i) => {
        if (i <= 1) return m; // system + 首条任务
        if (typeof m.content !== 'string') return m;
        if (m.content.length <= 600) return m;
        return { ...m, content: m.content.slice(0, 400) + `\n…（早期结果已压缩，原 ${m.content.length} 字符）` };
    });
    return compacted;
}

/**
 * 生成一层：统一返回 { text, reasoning, streamed }。
 * 优先级：调试 override → 指定连接配置（流式）→ 酒馆当前 chat completion（真流式）
 *        → 回退 generateRaw 全文 + 打字机补放。
 */
export async function stepGenerate(list, handlers = {}) {
    const onText = handlers.onText;
    const onReasoning = handlers.onReasoning;

    if (typeof generateOverride === 'function') {
        const text = await generateOverride(list);
        await typewrite(text, onText, abortController?.signal);
        return { text, reasoning: '', streamed: false };
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
            return { text, reasoning: request?.reasoning || '', streamed: false };
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
        return { text, reasoning, streamed: true };
    }

    // 酒馆「API 连接」= 当前配置。只有 chat completion 后端（main_api=openai）才有真流式，
    // kobold / novel / textgen 这些走 generateRaw + 打字机。
    if (settings.streamMode !== 'off' && c.mainApi === 'openai' && c.ChatCompletionService) {
        try {
            return await streamChatCompletion(list, { onText, onReasoning });
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
    return { text, reasoning: '', streamed: false };
}
