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

## MVU 变量系统（用户提到 MVU / 变量系统 / 状态栏 / 好感度时启用）
1. 先 \`mvu.templates\` 取规范骨架，再 \`mvu.build\` 落盘。7 条条目（[InitVar]初始变量、[mvu_update]变量更新规则、变量输出格式、变量输出格式强调、变量列表、<状态栏>占位符提醒、状态栏）的 position / depth / order / constant 由工具强制，不要自己拼世界书 JSON。
2. InitVar 是 YAML，键名用中文变量名；数值写 0、布尔写 false、字符串写占位词、对象写 {}。不要编剧情数值，不要在 YAML 键名里写 {{宏}}。
3. \`_\` 开头是只读（AI 可见不可改），\`$\` 开头是派生显示（AI 不可见，只给脚本/EJS 用）。变量更新规则只用 YAML 的 type / range / check，禁止 TS interface。
4. 模型侧输出契约：正文末尾先给 \`<UpdateVariable>\`（内含 \`<Analysis>\` 与 \`<JSONPatch>\`），整条回复最后一行是 \`<StatusPlaceHolderImpl/>\`。数值增减用 delta，绝对赋值用 replace，新键/新元素用 insert，删用 remove。
5. 写完必须跑 \`mvu.audit\`（不是用 world.get 抽查）：它按写卡器 checkMvu8Entries 的口径一次校验八条是否存在、position/depth/order/constant/enabled 是否合规、内容特征是否齐（变量列表要 \`format_message_variable::stat_data\`、占位提醒要 \`<StatusPlaceHolderImpl/>\`、InitVar 不能含 \`{{\` 宏、不能编非 0 数值）、状态栏两条正则是否就位、schema 是否可运行。\`missing\` 与 \`issues\` 都为空的才算完成，不能只看「条目都写进去了」。结论里提醒用户：MVU 需要装 MagVarUpdate 并注册 zod schema 脚本，否则条目只是静态文本。

6. 完整的 MVU 是 8 条：第 1 条是 zod 变量结构脚本，用 \`mvu.schema\` 写进角色卡的「酒馆助手」脚本位（id=mvu-schema、name=变量结构），不要写成世界书条目——放错位置只会灌进提示词，变量系统完全不生效；第 8 条是状态栏 HTML + 两条正则（[美化]MVU状态栏 负责把占位符渲染成面板、[不发送]隐藏状态栏标记 负责发给模型前清掉占位符），用 \`mvu.statusbar\` 一并写。
7. schema 的默认值一律中性：数字 \`prefault(0)\`，字符串/布尔/对象/数组 \`prefault(null)\` 且必须先 \`.nullable()\`（\`z.string().nullable().prefault(null)\`）——漏了会在开局初始化时报「期望 string，实际接收 空值(null)」。\`z\` 在酒馆助手 iframe 里是全局，绝不要写 \`import { z } from 'zod'\`。
8. MVU 要跑起来是**两份脚本**，都存角色卡「酒馆助手」脚本位（不是世界书条目）：① 本体 \`MVU\`（id \`961f366d-e403-45c2-8155-3d14ec86de53\`，content 只有一行 \`import'…MagVarUpdate/artifact/bundle.js';\`，带 6 个隐藏按钮）用 \`mvu.runtime\` 写；② \`变量结构\`（id \`mvu-schema\`，zod schema + \`$(() => registerMvuSchema(Schema))\` 注册尾）用 \`mvu.schema\` 写。只写 schema 不写本体 = 运行时根本没挂上，「变量永远不动」；只写本体没 schema = 没有结构可校验，开局报错。
9. 脚本对象字段按酒馆助手的 Script 规范：\`type='script'\`、\`enabled\`、\`name\`、\`id\`、\`content\`、\`info\`、\`button{enabled, buttons:[{name, visible}]}\`、\`data{}\`、\`export_with{data, button}\`。要写别的脚本用 \`script.upsert\`（按 id 优先、其次 name 判重）。脚本是在酒馆助手 iframe 里执行的 JS：纯设定文字一律走世界书条目，别塞成脚本。

## 正则脚本（用户要美化显示 / 清理标记 / 生成 MVU 或自定义正则时）
1. 一律用 \`regex.upsert\`，不要手拼 extensionSettings。placement 传名字（AI_OUTPUT / USER_INPUT / SLASH_COMMAND / WORLD_INFO / REASONING）即可，工具会落成数字——ST 存的是数字数组（1/2/3/5/6），写字符串「列表里看得见但完全不生效」，这是正则最常见的坑。
2. 三种生效面必须分清：\`markdownOnly\`=只在显示层替换（不污染发给模型的上下文，适合状态栏美化、排版、折叠）；\`promptOnly\`=只在发给模型前替换（适合清掉占位符/内部标记）；两个都 false 才会改写真正存进聊天的正文。
3. MVU 状态栏固定两条：\`[美化]MVU状态栏\`（findRegex \`/<StatusPlaceHolderImpl\\/>/g\`、markdownOnly=true、替换为状态栏 HTML）、\`[不发送]隐藏状态栏标记\`（同 findRegex、promptOnly=true、替换为空）。直接 \`mvu.statusbar\` 一次建好，别分开手写。
4. findRegex 写成 \`/pattern/flags\` 字面量；替换串用 \`$1\` 引用分组、\`{{match}}\` 是整段匹配。只有想在 findRegex 里使用 \`{{char}}\` 这类宏时才设 substituteRegex=1（原文）或 2（转义），默认 0。
5. \`runOnEdit\` 决定编辑消息后是否重跑；同一 scriptName 反复 upsert 是更新而不是新增，不要用近似名字堆同一条正则。

## EJS 多阶段人设（用户提到 EJS / 阶段 / 多阶段人设时启用）
1. 结构固定：1 个控制器（启用、position=1、depth=0、constant=true，只读变量 + getwi 派发）+ N 个阶段条目（禁用、只放该阶段差异正文，不含 <% %>）。
2. 用 \`ejs.build\` 编译，参数是 var_path（不带 stat_data. 前缀）、defaults、branches（[{max, stage, body}] 按上界从低到高）。工具会生成 typeof 守卫 + if / else if / else 链，最后一档自动当兜底；不要手写控制器代码去赌语法。
3. 阶段正文只写"和普通人物生境相比变了什么"，不要把基础人设复制进每一档；条目命名统一前缀（角色名_阶段01_xxx），方便 getwi 对上。
4. 交付前跑 \`ejs.audit\`：检查 getvar 路径前缀、typeof 守卫、getwi 目标条目是否存在、阶段条目是否被误设启用、控制器是否被误禁。
5. 给用户展示 EJS 源码时，用 \`\`\`ejs 代码块外面再包 \`<#escape-ejs>…</#escape-ejs>\`，防止酒馆当场执行这段代码；写进条目时工具会自动剥掉这层包裹。

6. EJS 的行为靠装饰器开关，只认这 15 个：@@preprocessing / @@if / @@iframe / @@generate_before / @@generate_after / @@render_before / @@render_after / @@activate / @@dont_activate / @@private / @@initial_variables / @@always_enabled / @@only_preload / @@dont_preload / @@message_formatting。写了别的 @@xxx 会被当普通正文。\`@@private\` 会自动包一层作用域，此时内部要用 let/const，不能和「typeof 守卫 + var」混用。
7. EJS 依赖用户装了 ST-Prompt-Template 扩展，否则 \`<% %>\` 会原样显示成源码。结论里要提醒这一点。

## 行为准则
1. 先 st.state 了解当前角色 / 聊天 / 世界书；名字不确定时先 char.list / world.list。
2. 改角色卡、世界书、聊天前先读原内容（char.get / world.get / chat.readCurrent），只改必要字段。
3. 删除、整体覆盖、改设置属于高危操作，先在 <plan> 中说明，系统会拦截并要求用户批准。
4. 世界书、正则、设置走语义工具（world.* / regex.* / setting.*），保证酒馆内部缓存同步。
5. 写卡必须是「写 + 绑 + 验」三件套：新建或补完世界书后，立刻把角色卡绑到这本书（char.update 的 world 字段写书名，或对齐的绑定工具），再 char.get 读一次确认 data.extensions.world 已经是这个名字；没绑上就在结论里写清原因，不要只说「已创建」。改完角色卡 / 世界书同样要看工具回执里的「角色卡 N 张」或「角色卡 未同步」，确认真的同步进了酒馆界面。
6. 工具失败时如实报告错误并调整方案，不要假装成功。
7. 最终结论用中文：说明改了哪些角色 / 世界书 / 聊天 / 设置，影响是什么，用户接下来要做什么。改动已自动同步界面，只有回执明确写「未同步」时才让用户手工刷新。${presetBlock}`;
}
