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
import { toolByName, toolsPrompt, activeTools } from './tools.js';
import { ADV_TOOLS, advToolByName, advToolsPrompt, helperInfo } from './adv-tools.js';

/* ------------------------------ 聊天内工具注册 ------------------------------ */

export function registerChatTools() {
    const c = ctx();
    if (!c.registerFunctionTool) return;
    for (const tool of [...activeTools(), ...ADV_TOOLS]) {
        const name = `stagent_${tool.name.replace(/\./g, '_')}`;
        if (!settings.registerChatTools) {
            c.unregisterFunctionTool?.(name);
            continue;
        }
        c.registerFunctionTool({
            name,
            displayName: `[Agent] ${tool.name}`,
            description: tool.desc,
            parameters: {
                type: 'object',
                properties: Object.fromEntries(Object.entries(tool.params).map(([k, v]) => [k, { type: 'string', description: v }])),
                required: Object.keys(tool.params),
            },
            action: async args => {
                try {
                    const result = await executeTool({ name: tool.name, args });
                    return typeof result === 'string' ? result : JSON.stringify(result);
                } catch (error) {
                    return `错误：${error.message}`;
                }
            },
        });
    }
}
