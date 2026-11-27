import { getContext } from '../../../extensions.js';
import { MODULE, BRIDGE_ID, DEFAULT_SETTINGS, settings, abortController, running, bridgeOnline, generateOverride, messages, currentView, setSettings, setAbortController, setRunning, setBridgeOnline, setMessages, setCurrentView, setGenerateOverride } from './index-state.js';
import { ctx, loadSettings, saveSettings, pingBridge, getProfiles, generateRawFn, getGenerateRaw, serializeHistory, rawGenerate } from './index-boot.js';
import { typewrite, MODEL_FIELD, buildChatPayload, streamChatCompletion } from './index-stream.js';
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

/* ------------------------------ 系统提示 ------------------------------ */

export async function buildSystemPrompt() {
    const c = ctx();
    let env = [
        `- 当前角色: ${c.characters?.[c.characterId]?.name || '（无）'}（${c.characters?.[c.characterId]?.avatar || '-'}）`,
        `- 当前聊天: ${c.chatId || '（无）'}，消息数 ${c.chat?.length ?? 0}`,
        `- 角色卡总数: ${(c.characters || []).length}`,
        `- 世界书: ${(c.getWorldInfoNames?.() ?? []).join('、') || '（无）'}`,
    ].join('\n');

    if (window.__staBridgeOnline) {
        try {
            const info = await (await fetch('/api/plugins/st-agent-bridge/info', { method: 'GET', headers: c.getRequestHeaders() })).json();
            if (info?.ok) {
                env += [
                    '',
                    '（额外：磁盘桥接已连接，可用 fs.* 与 exec）',
                    `- 酒馆根目录: ${info.data.stRoot}`,
                    `- 用户数据目录: ${info.data.userRoot || '(未识别)'}`,
                ].join('\n');
            }
        } catch { /* ignore */ }
    }

    return `你是 ST Agent，运行在 SillyTavern（酒馆）内部的自主 Agent。你通过酒馆自己的接口真实地增删改查酒馆数据：角色卡、世界书、聊天记录、设置、预设、正则、扩展，并能执行 STscript。

当前环境：
${env}

可用工具：
${toolsPrompt()}${advToolsPrompt()}

## 输出协议（必须严格遵守）

需要调用工具时，输出：
<tool_call name="工具名">
{"参数名": "值"}
</tool_call>

可以连续输出多个 tool_call。系统会执行它们并以 <tool_result name="..." ok="true">…</tool_result> 的形式回给你，然后你继续下一步。

任务完成时，用 <final>…</final> 给出结论。如果任务较大，可先输出 <plan>…</plan> 简述计划（不超过 5 行）。

不要用代码围栏包裹 tool_call。不要编造工具名。

## 批量操作（v1.10，重要）

要在同一处改多条（补十几条世界书条目、批量改角色字段、一次开几个正则），不要一条一个 tool_call，走三拍：

1. \`ops.plan {"ops":[{"tool":"world.upsertEntry","args":{...},"why":"补设定"} ...]}\`
   → 返回 planId + 每条的影响预测（create / update / delete / noop）、字段变化、警告、错误。
   预演不写盘；发现目标不存在、参数缺字段时会在 errors 里点出来。
2. 把预演结果摘要告诉用户（几条新增、几条更新、哪些会删），再 \`ops.apply {"ops":[...],"planId":"..."}\`。
   planId 会校验参数没被改过；单批上限 40 条，超了直接报错。
3. 执行回执里 errors 是逐条隔离的——某条失败不影响其余。要反悔就 \`ops.journals\` 找批次 id，\`ops.undo\` 逆序回滚（世界书整本 / 角色字段 / 设置键可回滚；聊天楼层、正则、脚本不行）。

## 行为准则
1. 先 st.state 了解当前角色 / 聊天 / 世界书；名字不确定时先 char.list / world.list。
2. 改角色卡、世界书、聊天前先读原内容（char.get / world.get / chat.readCurrent），只改必要字段。
3. 删除、整体覆盖、改设置属于高危操作，先在 <plan> 中说明，系统会拦截并要求用户批准。
4. 世界书、正则、设置走语义工具（world.* / regex.* / setting.*），保证酒馆内部缓存同步。
5. 工具失败时如实报告错误并调整方案，不要假装成功。
6. 最终结论用中文：说明改了哪些角色 / 世界书 / 聊天 / 设置，影响是什么，用户接下来要做什么（如刷新页面）。`;
}
