import { ctx, loadSettings, saveSettings, pingBridge, getProfiles, generateRawFn, getGenerateRaw, serializeHistory, rawGenerate } from './index-boot.js';
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

import { toolByName, toolsPrompt, activeTools } from './tools.js';
import { ADV_TOOLS, advToolByName, advToolsPrompt, helperInfo } from './adv-tools.js';

export const MODULE = 'st-agent';
export const BRIDGE_ID = 'st-agent-bridge';

export const DEFAULT_SETTINGS = {
    enabled: true,
    profileId: '',
    maxSteps: 20,
    maxTokens: 4096,
    approval: 'write', // auto | write | all
    registerChatTools: false,
    maxHistoryChars: 24000,
    showToolArgs: true,
    planMode: true,       // 模型给出 <plan> 且本轮有写操作时，先批准计划再执行
    batchConfirm: true,   // 同一轮的多个待批准操作合并成一张确认卡
    streamMode: 'auto',   // auto | off：chat completion 后端逐字流式
};

export let settings = { ...DEFAULT_SETTINGS };
export let abortController = null;
export let running = false;
export let bridgeOnline = false;
export let generateOverride = null; // 调试/自定义后端：async (messages) => string
export let messages = [];       // 当前会话（用于上下文）
export let currentView = null;  // 面板 DOM 引用

export const $ = (sel, root = document) => root.querySelector(sel);

/* ------------------------------ 状态写入（跨模块只读 live binding，写走 setter） ------------------------------ */

export function setSettings(v) { settings = v; }
export function setAbortController(v) { abortController = v; }
export function setRunning(v) { running = v; }
export function setBridgeOnline(v) { bridgeOnline = v; }
export function setMessages(v) { messages = v; }
export function setCurrentView(v) { currentView = v; }
export function setGenerateOverride(v) { generateOverride = v; }
