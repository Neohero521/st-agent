/**
 * 全局状态（唯一真源）
 *
 * 约定：
 *  - 各模块 import 时拿到的是 live binding，只读；
 *  - 任何写入必须走本文件导出的 setXxx，不允许直接改导出变量；
 *  - 本文件不 import 任何业务模块，避免循环依赖。
 */

export const MODULE = 'st-agent';
export const BRIDGE_ID = 'st-agent-bridge';

export const DEFAULT_SETTINGS = {
    enabled: true,
    profileId: '',
    maxSteps: 20,
    maxTokens: 8192,   // 单次输出上限；写卡/长脚本体量下 4096 会半路被切，4096 时代常被截断
    approval: 'write', // auto | write | all
    registerChatTools: false,
    maxHistoryChars: 24000,
    showToolArgs: true,
    planMode: true,       // 模型给出 <plan> 且本轮有写操作时，先批准计划再执行
    batchConfirm: true,   // 同一轮的多个待批准操作合并成一张确认卡
    usePreset: true,      // 每轮生成前读一次用户当前的 Chat Completion 预设（只取系统提示类块）
    chatContext: true,    // 发送任务时把酒馆当前聊天的最近几楼一起带上（Agent 才知道"现在聊到哪"）
    chatContextTurns: 8,  // 带最近几条聊天消息
    streamMode: 'auto',   // auto | off：chat completion 后端逐字流式
    sessionLimit: 20,     // 最多保留多少个会话（超出按最后使用时间淘汰）
    sessionCharBudget: 1200000, // 会话总字符预算，超出后先压缩最旧会话
    instructions: '',     // 常驻指令（对标 DSH 的 AGENTS.md：每轮都进 system，始终生效）
    schemaVersion: 3,     // 设置迁移标记
};

export let settings = { ...DEFAULT_SETTINGS };
export let abortController = null;
export let running = false;
export let bridgeOnline = false;
export let generateOverride = null; // 调试/自定义后端：async (messages) => string
export let messages = [];       // 当前会话的运行时上下文（含 system，不持久化）
export let currentView = null;  // 面板 DOM 引用

/** 会话列表：[{ id, title, createdAt, updatedAt, cardName, messages:[{role,content}] }] */
export let sessions = [];
/** 当前会话 id；空串表示尚未创建 */
export let activeSessionId = '';

export const $ = (sel, root = document) => root.querySelector(sel);

/* ------------------------------ 状态写入（跨模块只读 live binding，写走 setter） ------------------------------ */

export function setSettings(v) { settings = v; }
export function setAbortController(v) { abortController = v; }
export function setRunning(v) { running = v; }
export function setBridgeOnline(v) { bridgeOnline = v; }
export function setMessages(v) { messages = v; }
export function setCurrentView(v) { currentView = v; }
export function setGenerateOverride(v) { generateOverride = v; }
export function setSessions(v) { sessions = v; }
export function setActiveSessionId(v) { activeSessionId = v; }
