import { getContext } from '../../../extensions.js';
import { MODULE, BRIDGE_ID, DEFAULT_SETTINGS, settings, abortController, running, bridgeOnline, generateOverride, messages, currentView, setSettings, setAbortController, setRunning, setBridgeOnline, setMessages, setCurrentView, setGenerateOverride } from './index-state.js';
import { typewrite, MODEL_FIELD, buildChatPayload, streamChatCompletion } from './index-stream.js';
import { buildSystemPrompt } from './index-prompt.js';
import { parseToolCalls, repairJson, buildCall, extractFinal, sumChars, compactHistory, stepGenerate } from './index-loop.js';
import { HIGH_RISK_PATTERNS, RISK_META, riskOf, batchLines, executeTool, summarizeArgs, briefArgs } from './index-risk.js';
import { runAgent } from './index-agent.js';
import { html, buildPanel, bindPanel } from './index-ui.js';
import { buildMenuEntry, togglePanel, setBusy, updateStatus, addLog, addStreamingDraft } from './index-ui2.js';
import { askPlan, askApprovalBatch, askApproval, submitTask, populateProfiles, syncSettingsUI } from './index-ui3.js';
import { registerChatTools } from './index-tools.js';
import { refreshBridgeState, initialize } from './index.js';

export function ctx() { return getContext(); }

export function loadSettings() {
    const c = ctx();
    c.extensionSettings[MODULE] = c.extensionSettings[MODULE] || {};
    const raw = c.extensionSettings[MODULE];
    setSettings({ ...DEFAULT_SETTINGS, ...raw });
    // 迁移：老版本的默认单次输出上限只有 4096，写卡/长脚本必被切在半句。
    // 只在用户没自己动过（还是 4096）时抬到新默认，动过的一律尊重用户。
    if ((Number(raw.schemaVersion) || 0) < 3) {
        if (Number(settings.maxTokens) === 4096) settings.maxTokens = DEFAULT_SETTINGS.maxTokens;
        settings.schemaVersion = 3;
        c.extensionSettings[MODULE] = settings;
        c.saveSettingsDebounced?.();
    }
    c.extensionSettings[MODULE] = settings;
}

export function saveSettings() {
    const c = ctx();
    c.extensionSettings[MODULE] = settings;
    c.saveSettingsDebounced?.();
}

export async function pingBridge() {
    try {
        const response = await fetch(`/api/plugins/${BRIDGE_ID}/ping`, { method: 'GET', headers: ctx().getRequestHeaders() });
        const json = await response.json();
        setBridgeOnline(!!json?.ok);
        window.__staBridgeOnline = bridgeOnline;
        return bridgeOnline;
    } catch {
        setBridgeOnline(false);
        window.__staBridgeOnline = false;
        return false;
    }
}

export function getProfiles() {
    try {
        const svc = ctx().ConnectionManagerRequestService;
        return svc?.getSupportedProfiles?.() ?? [];
    } catch {
        return [];
    }
}

/* ------------------------------ 直连酒馆当前 API ------------------------------ */

export let generateRawFn;

export async function getGenerateRaw() {
    if (generateRawFn !== undefined) return generateRawFn;
    // script.js 在 public/ 下（扩展目录往上四级）；不同版本布局可能不同，所以逐个试
    for (const path of ['../../../../script.js', '../../../script.js']) {
        try {
            const mod = await import(path);
            if (typeof mod.generateRaw === 'function') {
                generateRawFn = mod.generateRaw;
                return generateRawFn;
            }
        } catch { /* try next */ }
    }
    generateRawFn = null;
    return generateRawFn;
}

export function serializeHistory(list) {
    const lines = [];
    for (const m of list) {
        if (m.role === 'system') continue;
        lines.push((m.role === 'assistant' ? '### 助手\n' : '### 用户\n') + String(m.content ?? ''));
    }
    return lines.join('\n\n') + '\n\n### 助手\n';
}

export async function rawGenerate(list) {
    const fn = await getGenerateRaw();
    if (!fn) {
        throw new Error('当前酒馆版本没有暴露 generateRaw，无法直连 API；请在酒馆「连接管理器」里建一个配置');
    }
    const system = list.find(m => m.role === 'system')?.content ?? '';
    const messages = list.filter(m => m.role !== 'system')
        .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') }));
    let reply;
    try {
        // 优先按 chat 消息数组传，保留角色结构
        reply = await fn({ prompt: messages, systemPrompt: system, responseLength: settings.maxTokens });
    } catch (error) {
        if (abortController?.signal?.aborted) throw error;
        try {
            // 兼容只吃字符串的旧版本
            reply = await fn({ prompt: serializeHistory(list), systemPrompt: system, responseLength: settings.maxTokens });
        } catch (second) {
            throw new Error(`酒馆当前 API 调用失败：${second?.message || error?.message || '未知错误'}。请检查酒馆「API 连接」页的模型与密钥。`);
        }
    }
    return typeof reply === 'string' ? reply : (reply?.content || '');
}
