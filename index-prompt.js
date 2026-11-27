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

const PRESET_CHAR_LIMIT = 6000;
const CHAT_LINE_LIMIT = 600;

/**
 * 把酒馆「当前聊天」的最近几楼一起带上。
 * 写卡器的做法：Agent 得知道用户现在正聊到哪，否则每次都要用户再把前情复述一遍。
 * 只取最近的、只读不改——这里给的是"参考背景"，不是要 Agent 去续写对话。
 */
function chatContextBlock() {
    if (settings.chatContext === false) return '';
    try {
        const c = ctx();
        const chat = Array.isArray(c.chat) ? c.chat : [];
        if (!chat.length) return '';
        const turns = Math.max(2, Math.min(40, Number(settings.chatContextTurns) || 8));
        const picked = [];
        for (const m of chat.slice(-turns)) {
            // 酒馆的系统消息（欢迎页那堆提示）里塞的是整段 HTML，进上下文纯属占地方
            if (m?.is_system) continue;
            const body = String(m?.mes ?? m?.content ?? '')
                .replace(/<[^>]*>/g, ' ')
                .replace(/[ \t\r\n]+/g, ' ')
                .trim();
            if (!body) continue;
            // 酒馆在没选角色 / AI 未接入时会自己插一条固定占位语，带着进上下文只是噪音
            if (!m?.is_user && /如果您已连接到|试着问我点什么|If you.*API connected|try asking me something/i.test(body)) continue;
            const who = m?.is_user ? '用户' : (String(m?.name || '').trim() || '角色');
            picked.push(`${who}: ${body.length > CHAT_LINE_LIMIT ? body.slice(0, CHAT_LINE_LIMIT) + '…' : body}`);
        }
        if (!picked.length) return '';
        return `

## 当前聊天上下文（最近 ${picked.length} 条）

${picked.join(String.fromCharCode(10))}

说明：这是酒馆里正在进行的对话，只作为背景让你知道"现在聊到哪"。除非用户明确要求，不要去改它、也不要把自己当成里面的角色继续往下写。`;
    } catch {
        return '';
    }
}

/**
 * 每轮生成前读一次用户当前的 Chat Completion 预设。
 *
 * 只取「系统提示类」的块（主提示 / 越狱或后置指令），刻意跳过三类东西：
 *   - marker 占位（worldInfoBefore/After、chatHistory、dialogueExamples…）
 *   - 对话示例、聊天记录
 *   - 世界书注入
 * 这些是为角色扮演准备的，塞进 Agent 的工具循环只会污染上下文、把工具协议冲掉。
 *
 * 每轮都重读：用户在生成过程中改了预设，下一轮立刻生效，不用重开酒馆。
 */
function readPresetBlocks() {
    const c = ctx();
    try {
        // 预设的「已展开」形态在 chatCompletionSettings（即 oai_settings）里。
        // 不能用 getSelectedPreset()——它只返回下拉框的 value（一个下标字符串），拿不到内容。
        const s = c.chatCompletionSettings;
        if (!s || !Array.isArray(s.prompts)) return null;
        const name = String(s.preset_settings_openai || '');

        const picked = [];
        for (const p of s.prompts) {
            if (!p || p.marker) continue;
            const ident = String(p.identifier || '');
            if (ident === 'chatHistory' || ident === 'dialogueExamples' || ident === 'worldInfoBefore' || ident === 'worldInfoAfter') continue;
            if (!p.system_prompt && ident !== 'jailbreak') continue;
            const body = String(p.content || '').trim();
            if (!body) continue;
            picked.push(body);
        }
        if (!picked.length) return null;

        let text = picked.join(String.fromCharCode(10, 10));
        if (text.length > PRESET_CHAR_LIMIT) text = text.slice(0, PRESET_CHAR_LIMIT) + String.fromCharCode(10) + '…（预设过长，已截断）';
        try { text = c.substituteParams?.(text) || text; } catch { /* 宏展开失败就用原文 */ }
        return { name, text };
    } catch {
        return null;
    }
}

export async function buildSystemPrompt() {
    const c = ctx();
    const NL = String.fromCharCode(10);
    let env = [
        `- 当前角色: ${c.characters?.[c.characterId]?.name || '（无）'}（${c.characters?.[c.characterId]?.avatar || '-'}）`,
        `- 当前聊天: ${c.chatId || '（无）'}，消息数 ${c.chat?.length ?? 0}`,
        `- 角色卡总数: ${(c.characters || []).length}`,
        `- 世界书: ${(c.getWorldInfoNames?.() ?? []).join('、') || '（无）'}`,
    ].join(NL);

    if (window.__staBridgeOnline) {
        try {
            const info = await (await fetch('/api/plugins/st-agent-bridge/info', { method: 'GET', headers: c.getRequestHeaders() })).json();
            if (info?.ok) {
                env += [
                    '',
                    '（额外：磁盘桥接已连接，可用 fs.* 与 exec）',
                    `- 酒馆根目录: ${info.data.stRoot}`,
                    `- 用户数据目录: ${info.data.userRoot || '(未识别)'}`,
                ].join(NL);
            }
        } catch { /* ignore */ }
    }

    // 用户预设：每轮现读，放在协议之后——它是语气与世界观参考，不能盖掉工具协议
    const preset = settings.usePreset === false ? null : readPresetBlocks();
    const presetBlock = preset
        ? `

## 用户预设（来自酒馆预设「${preset.name || '未命名'}」）

以下是用户在自己预设里写的内容，用于语言、语气、称呼与世界观。它不改变上面的工具协议；两者冲突时，以工具协议的格式要求为准。

${preset.text}`
        : '';

    return `你是 ST Agent，运行在 SillyTavern（酒馆）内部的自主 Agent。你通过酒馆自己的接口真实地增删改查酒馆数据：角色卡、世界书、聊天记录、设置、预设、正则、扩展，并能执行 STscript。

当前环境：
${env}${chatContextBlock()}

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
5. 写卡必须是「写 + 绑 + 验」三件套：新建或补完世界书后，立刻把角色卡绑到这本书（char.update 的 world 字段写书名，或对齐的绑定工具），再 char.get 读一次确认 data.extensions.world 已经是这个名字；没绑上就在结论里写清原因，不要只说「已创建」。改完角色卡 / 世界书同样要看工具回执里的「角色卡 N 张」或「角色卡 未同步」，确认真的同步进了酒馆界面。
6. 工具失败时如实报告错误并调整方案，不要假装成功。
7. 最终结论用中文：说明改了哪些角色 / 世界书 / 聊天 / 设置，影响是什么，用户接下来要做什么。改动已自动同步界面，只有回执明确写「未同步」时才让用户手工刷新。${presetBlock}`;
}
