import { getContext } from '../../../extensions.js';
import { MODULE, BRIDGE_ID, DEFAULT_SETTINGS, settings, abortController, running, bridgeOnline, generateOverride, messages, currentView, setSettings, setAbortController, setRunning, setBridgeOnline, setMessages, setCurrentView, setGenerateOverride } from './index-state.js';
import { ctx, loadSettings, saveSettings, pingBridge, getProfiles, generateRawFn, getGenerateRaw, serializeHistory, rawGenerate } from './index-boot.js';
import { buildSystemPrompt } from './index-prompt.js';
import { parseToolCalls, repairJson, buildCall, extractFinal, sumChars, compactHistory, stepGenerate } from './index-loop.js';
import { HIGH_RISK_PATTERNS, RISK_META, riskOf, batchLines, executeTool, summarizeArgs, briefArgs } from './index-risk.js';
import { runAgent } from './index-agent.js';
import { html, buildPanel, bindPanel } from './index-ui.js';
import { buildMenuEntry, togglePanel, setBusy, updateStatus, addLog, addStreamingDraft } from './index-ui2.js';
import { askPlan, askApprovalBatch, askApproval, submitTask, populateProfiles, syncSettingsUI } from './index-ui3.js';
import { registerChatTools } from './index-tools.js';

/**
 * 打字机补放：非流式后端拿到全文后，按字符推进渲染。
 * `generateRaw` 走 sendOpenAIRequest('quiet') 不发流事件，所以只能事后补放；
 * 这不是真流式，但至少不会让长任务“空白卡住几十秒”。
 */
export function typewrite(text, emit, signal, speed = 0) {
    return new Promise((resolve, reject) => {
        const full = String(text ?? '');
        if (!full) { emit?.(full); return resolve(); }
        // 页面在后台（手机切走 / 锁屏 / 切到别的 App）时，setTimeout 会被浏览器降频到 1 次/秒，
        // 一段几十字的回复能把一轮卡十几秒。这时候别打动画了，直接一次性给出全文。
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
        if (hidden) { emit?.(full); return resolve(); }
        const step = speed || (full.length > 8000 ? 12 : full.length > 3000 ? 6 : 3);
        const delay = full.length > 8000 ? 4 : 8;
        let i = 0;
        const t0 = Date.now();
        // 兜底预算：正常打完这段文字最多这么久。被节流时直接补全文，绝不让调用方无限等。
        const budget = Math.ceil(full.length / step) * delay * 3 + 1200;
        const tick = () => {
            if (signal?.aborted) return reject(new Error('已中止'));
            i = Math.min(full.length, i + step);
            emit?.(full.slice(0, i));
            if (i >= full.length) return resolve();
            if (Date.now() - t0 > budget) { emit?.(full); return resolve(); }
            setTimeout(tick, delay);
        };
        tick();
    });
}

/* ---- chat completion 真流式（绕过生成预设，直接喂 messages） ---- */

export const MODEL_FIELD = {
    openai: 'openai_model',
    claude: 'claude_model',
    makersuite: 'google_model',
    vertexai: 'vertexai_model',
    mistralai: 'mistralai_model',
    custom: 'custom_model',
    cohere: 'cohere_model',
    perplexity: 'perplexity_model',
    groq: 'groq_model',
    deepseek: 'deepseek_model',
    xai: 'xai_model',
    zai: 'zai_model',
    moonshot: 'moonshot_model',
    siliconflow: 'siliconflow_model',
    minimax: 'minimax_model',
    workers_ai: 'workers_ai_model',
    pollinations: 'pollinations_model',
};

export function buildChatPayload(chatMessages) {
    const c = ctx();
    // ST 1.13+ 的 getContext() 不再直接暴露 oai_settings，改叫 chatCompletionSettings；
    // 模型名优先问 getChatCompletionModel()（它会按当前 source 取对应字段）。
    const oai = c.chatCompletionSettings || c.oai_settings || {};
    const source = oai.chat_completion_source || 'openai';
    let model = '';
    try {
        model = typeof c.getChatCompletionModel === 'function' ? (c.getChatCompletionModel() || '') : '';
    } catch { model = ''; }
    model = model || oai[MODEL_FIELD[source]] || oai.openai_model || '';
    const payload = {
        stream: true,
        messages: chatMessages,
        model,
        chat_completion_source: source,
        max_tokens: settings.maxTokens,
        temperature: Number(oai.temp_openai ?? 1),
        use_sysprompt: true,
        reverse_proxy: oai.reverse_proxy || undefined,
        proxy_password: oai.proxy_password || undefined,
    };
    if (source === 'custom') payload.custom_url = oai.custom_url;
    if (source === 'azure_openai') {
        payload.azure_base_url = oai.azure_base_url;
        payload.azure_deployment_name = oai.azure_deployment_name;
        payload.azure_api_version = oai.azure_api_version;
    }
    if (source === 'vertexai') payload.vertexai_region = oai.vertexai_region;
    if (source === 'siliconflow') payload.siliconflow_endpoint = oai.siliconflow_endpoint;
    if (source === 'minimax') payload.minimax_endpoint = oai.minimax_endpoint;
    return payload;
}

/**
 * 用 ST 自己的 ChatCompletionService 直接发流式请求。
 * 好处：完全是自定义 messages（Agent 的 system + 工具回执），不掺角色卡 / 世界书 / 生成预设。
 * 返回 { text, reasoning, streamed }。若服务端不支持流式，会返回一次性结果（streamed=false）。
 */
export async function streamChatCompletion(list, { onText, onReasoning } = {}) {
    const c = ctx();
    const svc = c.ChatCompletionService;
    if (!svc?.processRequest) throw new Error('当前酒馆没有 ChatCompletionService，无法流式');

    const chatMessages = list.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user'),
        content: String(m.content ?? ''),
    }));
    const payload = buildChatPayload(chatMessages);
    if (!payload.model) throw new Error('当前 API 没有可用模型名（检查「API 连接」页）');

    const gen = await svc.processRequest(payload, {}, true, abortController?.signal);
    if (typeof gen !== 'function') {
        const text = gen?.content ?? '';
        onText?.(text);
        return { text, reasoning: gen?.reasoning ?? '', streamed: false };
    }

    let text = '';
    let reasoning = '';
    for await (const chunk of gen()) {
        if (abortController?.signal?.aborted) break;
        if (typeof chunk?.text === 'string' && chunk.text !== text) {
            text = chunk.text;
            onText?.(text);
        }
        const nextReasoning = chunk?.state?.reasoning;
        if (typeof nextReasoning === 'string' && nextReasoning !== reasoning) {
            reasoning = nextReasoning;
            onReasoning?.(reasoning, false);
        }
    }
    if (reasoning) onReasoning?.(reasoning, true);
    return { text, reasoning, streamed: true };
}
