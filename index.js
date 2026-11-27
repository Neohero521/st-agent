// 模块求值标记：用来区分「模块没执行」和「执行后初始化失败」
try { document.documentElement.dataset.staMod = String(Date.now()); } catch (e) {}

import { getContext } from '../../../extensions.js';
import { MODULE, BRIDGE_ID, DEFAULT_SETTINGS, settings, abortController, running, bridgeOnline, generateOverride, messages, currentView, setSettings, setAbortController, setRunning, setBridgeOnline, setMessages, setCurrentView, setGenerateOverride } from './index-state.js';
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
import { initSessions, flushSessions, getActiveSession, createSession, installSessionPersistence } from './index-sessions.js';
import { toolByName, toolsPrompt, activeTools } from './tools.js';
import { ADV_TOOLS, advToolByName, advToolsPrompt, helperInfo } from './adv-tools.js';

/* ------------------------------ 初始化 ------------------------------ */

export async function refreshBridgeState() {
    const online = await pingBridge();
    const th = helperInfo();
    if (currentView) {
        const parts = ['酒馆内工具（角色卡 / 世界书 / 聊天 / 变量 / 注入 / 正则 / STscript）'];
        if (th.online) parts.push(`酒馆助手 v${th.version}（脚本树可控）`);
        if (online) parts.push('磁盘桥接（任意文件 + 命令）');
        currentView.root.querySelector('.sta-bridge-state').textContent = parts.join(' + ');
        updateStatus('就绪');
    }
    return online;
}

export function initialize() {
    loadSettings();
    // 调试 / 二次开发出口
    window.STAgent = {
        run: runAgent,
        executeTool,
        parseToolCalls,
        get tools() { return [...activeTools(), ...ADV_TOOLS]; },
        mockGenerate: fn => { setGenerateOverride(typeof fn === 'function' ? fn : null); },
        get settings() { return settings; },
        stop: () => abortController?.abort(),
        open: () => togglePanel(true),
        close: () => togglePanel(false),
        riskOf,
        streamChat: (list, handlers) => streamChatCompletion(list, handlers),
        askPlan,
        askApprovalBatch,
        sessions: {
            list: () => getActiveSession(),
            create: title => createSession(title),
        },
    };
    if (!settings.enabled) return;
    if (document.querySelector('.sta-root')) return; // 幂等：避免重复加载时叠加面板
    buildPanel();
    initSessions();
    installSessionPersistence();
    window.addEventListener('beforeunload', flushSessions);
    buildMenuEntry();
    populateProfiles();
    syncSettingsUI();
    refreshBridgeState().then(() => registerChatTools());

    // 打开扩展设置面板时同步
    const settingsHost = document.getElementById('extensions_settings');
    if (settingsHost) {
        const card = document.createElement('div');
        card.className = 'sta-settings-card';
        card.innerHTML = '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>ST Agent</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><p>打开面板：桌面端点右下角「Agent」悬浮球；手机端点输入框上方的魔杖菜单 → ST Agent。</p><p>模型默认用酒馆「API 连接」里配的当前 API，不需要另建连接配置。</p><p>任意磁盘读写与 shell 需额外安装可选插件 <code>st-agent-bridge</code>（config.yaml 设 <code>enableServerPlugins: true</code>）。</p></div></div>';
        settingsHost.appendChild(card);
    }
}

/**
 * 启动。
 *
 * 这里不用 jQuery(...) 包一层：酒馆 1.19 起前端脚本的注入时机前移，
 * 模块求值时全局 jQuery 可能还没挂上，`jQuery is not defined` 会让整个模块
 * 在顶层就抛掉——表现就是「扩展列表里有 ST Agent，但面板/悬浮球一个都不出现」，
 * 而且控制台看不出是谁的锅。改成原生 DOM ready + 上下文就绪重试，与 jQuery 无关。
 */
let bootAttempts = 0;

function contextReady() {
    try {
        if (typeof getContext !== 'function') return false;
        const c = getContext();
        return !!(c && typeof c === 'object');
    } catch { return false; }
}

function boot() {
    if (window.__staBooted) return;
    try {
        if (!contextReady()) throw new Error('酒馆上下文还没就绪');
        initialize();
        window.__staBooted = true;
        console.log('[st-agent] booted. panel =', !!document.querySelector('.sta-panel'));
    } catch (error) {
        bootAttempts += 1;
        if (bootAttempts <= 6) {
            // 400ms / 800ms / 1.2s… 逐次退避，最多 6 次；手机端弱机冷启动也够用
            setTimeout(boot, 400 * bootAttempts);
        } else {
            console.error('[st-agent] 初始化失败：', error);
        }
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
    boot();
}

// 极端情况：ST 把脚本注入到还没建好的 body 上（1.19 的 extensions 注入时序），
// 模块虽执行了但 DOM 不完整。再排一次到 window load，幂等，重复调用无副作用。
window.addEventListener('load', () => { setTimeout(boot, 0); }, { once: true });
