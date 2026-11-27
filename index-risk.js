import { MODULE, BRIDGE_ID, DEFAULT_SETTINGS, settings, abortController, running, bridgeOnline, generateOverride, messages, currentView, setSettings, setAbortController, setRunning, setBridgeOnline, setMessages, setCurrentView, setGenerateOverride } from './index-state.js';
import { ctx, loadSettings, saveSettings, pingBridge, getProfiles, generateRawFn, getGenerateRaw, serializeHistory, rawGenerate } from './index-boot.js';
import { typewrite, MODEL_FIELD, buildChatPayload, streamChatCompletion } from './index-stream.js';
import { buildSystemPrompt } from './index-prompt.js';
import { parseToolCalls, repairJson, buildCall, extractFinal, sumChars, compactHistory, stepGenerate } from './index-loop.js';
import { runAgent } from './index-agent.js';
import { html, buildPanel, bindPanel } from './index-ui.js';
import { buildMenuEntry, togglePanel, setBusy, updateStatus, addLog, addStreamingDraft } from './index-ui2.js';
import { askPlan, askApprovalBatch, askApproval, submitTask, populateProfiles, syncSettingsUI } from './index-ui3.js';
import { registerChatTools } from './index-tools.js';
import { toolByName, toolsPrompt, activeTools } from './tools.js';
import { refreshAfterWrite } from './index-sync.js';
import { planGate } from './index-plan.js';
import { ADV_TOOLS, advToolByName, advToolsPrompt, helperInfo } from './adv-tools.js';

/* ------------------------------ 写后刷新回执 ------------------------------ */
// 界面上"这步到底同步了没有"要能给用户看到：手机端最常问的就是"为什么我还要刷新一遍"。
let lastRefreshNote = [];
export function takeRefreshNote() {
    const v = lastRefreshNote;
    lastRefreshNote = [];
    return Array.isArray(v) ? v : [];
}

/* ------------------------------ 风险分级 ------------------------------ */

// 风险 3 = 高危（删除 / 整本覆盖 / 改设置 / 执行命令），2 = 写入，1 = 只读
export const HIGH_RISK_PATTERNS = [
    /\.delete$/,
    /\.deleteEntry$/,
    /\.deleteMessage$/,
    /^world\.save$/,
    /^setting\.set$/,
    /^fs\.(write|edit|copy)$/,
    /^exec$/,
    /^ops\.undo$/,
    /^extension\.(install|delete)$/,
    /^preset\.(delete|save)$/,
    /^st\.command$/,
];

export const RISK_META = {
    3: { label: '高危', cls: 'sta-risk-3' },
    2: { label: '写入', cls: 'sta-risk-2' },
    1: { label: '只读', cls: 'sta-risk-1' },
};

export function riskOf(call) {
    const tool = toolByName(call.name) || advToolByName(call.name);
    let level = tool?.kind === 'dangerous' || tool?.kind === 'exec' ? 3 : tool?.kind === 'write' ? 2 : 1;
    if (HIGH_RISK_PATTERNS.some(re => re.test(call.name))) level = 3;
    // ops.apply 是批量器：风险取决于里面装了什么
    if (call.name === 'ops.apply') {
        const ops = Array.isArray(call.args?.ops) ? call.args.ops : [];
        if (ops.length > 8) level = 3;
        const riskyInner = ops.some(op => {
            const inner = String(op?.tool || op?.name || '');
            return HIGH_RISK_PATTERNS.some(re => re.test(inner));
        });
        if (riskyInner) level = 3;
    }
    return level;
}

export function batchLines(calls) {
    return calls.map((call, i) => {
        const level = riskOf(call);
        return `${i + 1}. ${call.name}  ·  ${RISK_META[level].label}  ·  ${summarizeArgs(call.args)}`;
    }).join('\n');
}

export async function executeTool(call) {
    const tool = toolByName(call.name) || advToolByName(call.name);
    if (!tool) throw new Error(`未知工具：${call.name}`);
    if (call.parseError) throw new Error(`参数不是合法 JSON：${call.parseError}`);

    // 计划门（v1.22）：计划模式下、这份计划还没批准时，写类工具直接挡回。
    // DSH 的 plan-mode 明确只做「软引导」不拦工具；手机端模型爱抢跑，所以这里反过来硬拦——只读工具照常放行。
    try {
        const gate = planGate(call.name, riskOf(call));
        if (gate) return gate;
    } catch (e) {
        console.warn('[st-agent] 计划门异常（放行）：', e && e.message);
    }

    const result = await tool.run(call.args || {});

    // 写类工具：执行完立刻把酒馆 UI 同步过来，用户不用手动刷新页面
    try {
        lastRefreshNote = await refreshAfterWrite(call.name, riskOf(call));
    } catch (error) {
        lastRefreshNote = [];
        console.warn('[st-agent] 写后刷新异常：', error && error.message);
    }

    return result;
}

export function summarizeArgs(args) {
    try {
        const s = JSON.stringify(args);
        return s.length > 160 ? s.slice(0, 160) + '…' : s;
    } catch {
        return String(args);
    }
}

/** 计划卡用的人类可读目标：能读懂"改哪儿"比看一坨 JSON 有用 */
export function briefArgs(name, args) {
    const a = args && typeof args === 'object' ? args : {};
    if (name === 'ops.plan' || name === 'ops.apply') {
        const n = Array.isArray(a.ops) ? a.ops.length : 0;
        return `${n} 条操作`;
    }
    if (a.name && a.comment) return `${a.name} / ${a.comment}`;
    if (a.name && a.newName) return `${a.name} → ${a.newName}`;
    if (a.path) return String(a.path);
    if (a.scriptName) return String(a.scriptName);
    if (a.name) return String(a.name);
    return summarizeArgs(args);
}
