import { getContext } from '../../../extensions.js';
import { toolByName, toolsPrompt, activeTools } from './tools.js';

const MODULE = 'st-agent';
const BRIDGE_ID = 'st-agent-bridge';

const DEFAULT_SETTINGS = {
    enabled: true,
    profileId: '',
    maxSteps: 20,
    maxTokens: 4096,
    approval: 'write', // auto | write | all
    registerChatTools: false,
    maxHistoryChars: 24000,
    showToolArgs: true,
};

let settings = { ...DEFAULT_SETTINGS };
let abortController = null;
let running = false;
let bridgeOnline = false;
let generateOverride = null; // 调试/自定义后端：async (messages) => string
let messages = [];       // 当前会话（用于上下文）
let currentView = null;  // 面板 DOM 引用

const $ = (sel, root = document) => root.querySelector(sel);

function ctx() { return getContext(); }

function loadSettings() {
    const c = ctx();
    c.extensionSettings[MODULE] = c.extensionSettings[MODULE] || {};
    settings = { ...DEFAULT_SETTINGS, ...c.extensionSettings[MODULE] };
    c.extensionSettings[MODULE] = settings;
}

function saveSettings() {
    const c = ctx();
    c.extensionSettings[MODULE] = settings;
    c.saveSettingsDebounced?.();
}

async function pingBridge() {
    try {
        const response = await fetch(`/api/plugins/${BRIDGE_ID}/ping`, { method: 'GET', headers: ctx().getRequestHeaders() });
        const json = await response.json();
        bridgeOnline = !!json?.ok;
        window.__staBridgeOnline = bridgeOnline;
        return bridgeOnline;
    } catch {
        bridgeOnline = false;
        window.__staBridgeOnline = false;
        return false;
    }
}

function getProfiles() {
    try {
        const svc = ctx().ConnectionManagerRequestService;
        return svc?.getSupportedProfiles?.() ?? [];
    } catch {
        return [];
    }
}

/* ------------------------------ 直连酒馆当前 API ------------------------------ */

let generateRawFn;

async function getGenerateRaw() {
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

function serializeHistory(list) {
    const lines = [];
    for (const m of list) {
        if (m.role === 'system') continue;
        lines.push((m.role === 'assistant' ? '### 助手\n' : '### 用户\n') + String(m.content ?? ''));
    }
    return lines.join('\n\n') + '\n\n### 助手\n';
}

async function rawGenerate(list, onChunk) {
    const fn = await getGenerateRaw();
    if (!fn) {
        throw new Error('当前酒馆版本没有暴露 generateRaw，无法直连 API；请在酒馆「连接管理器」里建一个配置');
    }
    const system = list.find(m => m.role === 'system')?.content ?? '';
    const messages = list.filter(m => m.role !== 'system')
        .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') }));
    onChunk?.('（酒馆当前 API 生成中…长任务可能要等一会儿）');
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
    const text = typeof reply === 'string' ? reply : (reply?.content || '');
    onChunk?.(text);
    return text;
}

/* ------------------------------ 系统提示 ------------------------------ */

async function buildSystemPrompt() {
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
${toolsPrompt()}

## 输出协议（必须严格遵守）

需要调用工具时，输出：
<tool_call name="工具名">
{"参数名": "值"}
</tool_call>

可以连续输出多个 tool_call。系统会执行它们并以 <tool_result name="..." ok="true">…</tool_result> 的形式回给你，然后你继续下一步。

任务完成时，用 <final>…</final> 给出结论。如果任务较大，可先输出 <plan>…</plan> 简述计划（不超过 5 行）。

不要用代码围栏包裹 tool_call。不要编造工具名。

## 行为准则
1. 先 st.state 了解当前角色 / 聊天 / 世界书；名字不确定时先 char.list / world.list。
2. 改角色卡、世界书、聊天前先读原内容（char.get / world.get / chat.readCurrent），只改必要字段。
3. 删除、整体覆盖、改设置属于高危操作，先在 <plan> 中说明，系统会拦截并要求用户批准。
4. 世界书、正则、设置走语义工具（world.* / regex.* / setting.*），保证酒馆内部缓存同步。
5. 工具失败时如实报告错误并调整方案，不要假装成功。
6. 最终结论用中文：说明改了哪些角色 / 世界书 / 聊天 / 设置，影响是什么，用户接下来要做什么（如刷新页面）。`;
}

/* ------------------------------ 循环 ------------------------------ */

function parseToolCalls(text) {
    const calls = [];
    let rest = String(text || '');

    // 1) <tool_call name="x">{...}</tool_call>
    const re = /<tool_call\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/tool_call>/gi;
    let m;
    while ((m = re.exec(rest))) {
        calls.push(buildCall(m[1], m[2]));
    }
    rest = rest.replace(re, '');

    // 2) <tool_call>{"name":"x","arguments":{...}}</tool_call>
    const re2 = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
    while ((m = re2.exec(rest))) {
        try {
            const obj = JSON.parse(m[1]);
            const name = obj.name || obj.tool;
            const args = obj.arguments || obj.args || obj.parameters || {};
            if (name) calls.push({ name, args, raw: m[0] });
        } catch { /* ignore */ }
    }
    rest = rest.replace(re2, '');

    // 3) ```json {"tool": "...", "args": {...}} ```
    const re3 = /```(?:json)?\s*(\{[\s\S]*?"(?:tool|name)"[\s\S]*?\})\s*```/gi;
    while ((m = re3.exec(rest))) {
        try {
            const obj = JSON.parse(m[1]);
            const name = obj.tool || obj.name;
            const args = obj.args || obj.arguments || obj.parameters || {};
            if (name && toolByName(name)) calls.push({ name, args, raw: m[0] });
        } catch { /* ignore */ }
    }
    return calls;
}

/**
 * 修复模型常见的“JSON 字符串里带裸换行/制表符”问题，只在字符串上下文内转义。
 */
function repairJson(raw) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (const ch of String(raw)) {
        if (escaped) { out += ch; escaped = false; continue; }
        if (ch === '\\') { out += ch; escaped = true; continue; }
        if (ch === '"') { inString = !inString; out += ch; continue; }
        if (inString) {
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') { continue; }
            if (ch === '\t') { out += '\\t'; continue; }
            if (ch < ' ') { out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'); continue; }
        }
        out += ch;
    }
    return out;
}

function buildCall(name, rawArgs) {
    const trimmed = String(rawArgs || '').trim();
    if (!trimmed) return { name, args: {}, raw: '' };
    try {
        return { name, args: JSON.parse(trimmed), raw: '' };
    } catch (e) {
        try {
            return { name, args: JSON.parse(repairJson(trimmed)), raw: '' };
        } catch (e2) {
            return { name, args: {}, parseError: e2.message, raw: trimmed.slice(0, 200) };
        }
    }
}

function extractFinal(text) {
    const m = /<final>([\s\S]*?)<\/final>/i.exec(text);
    if (m) return m[1].trim();
    return null;
}

function sumChars(list) {
    return list.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
}

function compactHistory(list) {
    if (sumChars(list) <= settings.maxHistoryChars) return list;
    const compacted = list.map((m, i) => {
        if (i <= 1) return m; // system + 首条任务
        if (typeof m.content !== 'string') return m;
        if (m.content.length <= 600) return m;
        return { ...m, content: m.content.slice(0, 400) + `\n…（早期结果已压缩，原 ${m.content.length} 字符）` };
    });
    return compacted;
}

async function stepGenerate(list, onChunk) {
    if (typeof generateOverride === 'function') {
        const text = await generateOverride(list);
        onChunk?.(text);
        return text;
    }
    const svc = ctx().ConnectionManagerRequestService;
    const profileId = settings.profileId;
    // 默认（未选连接配置）→ 直接用酒馆「API 连接」里配置的当前 API
    if (!profileId || !svc) {
        return rawGenerate(list, onChunk);
    }
    const request = await svc.sendRequest(profileId, list, settings.maxTokens, {
        stream: true,
        extractData: true,
        includePreset: false,
        includeInstruct: false,
        signal: abortController?.signal,
    });
    if (typeof request !== 'function') {
        return request?.content || '';
    }
    let text = '';
    for await (const chunk of request()) {
        text = chunk.text || text;
        onChunk?.(text);
        if (abortController?.signal?.aborted) break;
    }
    return text;
}

async function executeTool(call) {
    const tool = toolByName(call.name);
    if (!tool) throw new Error(`未知工具：${call.name}`);
    if (call.parseError) throw new Error(`参数不是合法 JSON：${call.parseError}`);
    return tool.run(call.args || {});
}

function summarizeArgs(args) {
    try {
        const s = JSON.stringify(args);
        return s.length > 160 ? s.slice(0, 160) + '…' : s;
    } catch {
        return String(args);
    }
}

async function runAgent(task) {
    if (running) return;
    running = true;
    abortController = new AbortController();
    setBusy(true);

    const view = currentView;
    view.log.innerHTML = '';
    addLog('user', task);

    const system = await buildSystemPrompt();
    messages = [{ role: 'system', content: system }, { role: 'user', content: task }];

    let steps = 0;
    try {
        while (steps < settings.maxSteps) {
            if (abortController.signal.aborted) { addLog('error', '已停止'); break; }
            steps++;
            updateStatus(`第 ${steps} 步 · 思考中`);

            const draft = addStreamingDraft();
            const reply = await stepGenerate(compactHistory(messages), text => { draft.body.textContent = text; });
            draft.cleanup();

            const calls = parseToolCalls(reply);
            const final = extractFinal(reply);

            if (calls.length === 0) {
                addLog('final', final || reply || '（模型没有输出内容）');
                messages.push({ role: 'assistant', content: reply });
                break;
            }

            const plan = /<plan>([\s\S]*?)<\/plan>/i.exec(reply);
            if (plan) addLog('plan', plan[1].trim());

            messages.push({ role: 'assistant', content: reply });

            for (const call of calls) {
                if (abortController.signal.aborted) break;
                const tool = toolByName(call.name);
                const kind = tool?.kind || 'write';
                const needApproval = settings.approval === 'all'
                    || (settings.approval === 'write' && ['write', 'exec', 'dangerous'].includes(kind))
                    || kind === 'dangerous';

                if (needApproval) {
                    const approved = await askApproval(call);
                    if (!approved) {
                        const denied = `<tool_result name="${call.name}" ok="false">用户拒绝执行该操作。</tool_result>`;
                        addLog('tool', call.name, '已被用户拒绝', 'denied');
                        messages.push({ role: 'user', content: denied });
                        continue;
                    }
                }

                const entry = addLog('tool', call.name, settings.showToolArgs ? summarizeArgs(call.args) : '');
                updateStatus(`第 ${steps} 步 · 执行 ${call.name}`);
                let payload;
                let ok = true;
                try {
                    const result = await executeTool(call);
                    payload = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                } catch (error) {
                    ok = false;
                    payload = `执行失败：${error.message}`;
                }
                entry.setResult(payload, ok);
                messages.push({
                    role: 'user',
                    content: `<tool_result name="${call.name}" ok="${ok}">${String(payload).slice(0, 12000)}</tool_result>`,
                });
            }

            if (final && calls.length === 0) break;
            if (final) addLog('final', final);
            if (abortController.signal.aborted) break;
        }
        if (steps >= settings.maxSteps) addLog('error', `已达到最大步数 ${settings.maxSteps}，任务可能未完成`);
    } catch (error) {
        if (!abortController?.signal?.aborted) addLog('error', `运行出错：${error.message}`);
    } finally {
        running = false;
        abortController = null;
        setBusy(false);
        updateStatus('就绪');
    }
}

/* ------------------------------ UI ------------------------------ */

function html(strings, ...values) {
    return strings.reduce((out, s, i) => out + s + (values[i] ?? ''), '');
}

function buildPanel() {
    const root = document.createElement('div');
    root.className = 'sta-root';
    root.innerHTML = html`
        <button class="sta-fab" title="ST Agent">
            <span class="sta-fab-dot"></span>
            <span class="sta-fab-text">Agent</span>
        </button>
        <section class="sta-panel" aria-hidden="true">
            <header class="sta-header">
                <div class="sta-brand">
                    <div class="sta-logo">SA</div>
                    <div>
                        <div class="sta-title">ST Agent</div>
                        <div class="sta-sub"><span class="sta-dot"></span><span class="sta-status">连接中…</span></div>
                    </div>
                </div>
                <div class="sta-head-actions">
                    <button class="sta-icon-btn sta-gear" title="设置">⚙</button>
                    <button class="sta-icon-btn sta-close" title="关闭">✕</button>
                </div>
            </header>
            <div class="sta-log" role="log"></div>
            <div class="sta-approval" hidden>
                <div class="sta-approval-text"></div>
                <div class="sta-approval-actions">
                    <button class="sta-btn ghost sta-deny">否</button>
                    <button class="sta-btn primary sta-allow">允许</button>
                </div>
            </div>
            <div class="sta-composer">
                <textarea class="sta-input" rows="1" placeholder="交代任务，Shift+Enter 换行"></textarea>
                <div class="sta-composer-actions">
                    <button class="sta-btn ghost sta-stop" hidden>停止</button>
                    <button class="sta-btn primary sta-send">执行</button>
                </div>
            </div>
            <div class="sta-drawer" hidden>
                <div class="sta-drawer-head">
                    <span>设置</span>
                    <button class="sta-icon-btn sta-drawer-close">✕</button>
                </div>
                <label class="sta-field">
                    <span>模型来源</span>
                    <select class="sta-profile"></select>
                </label>
                <label class="sta-field">
                    <span>最大步数</span>
                    <input class="sta-maxsteps" type="number" min="1" max="100" />
                </label>
                <label class="sta-field">
                    <span>审批策略</span>
                    <select class="sta-approval-policy">
                        <option value="auto">仅高危操作确认</option>
                        <option value="write">写操作都确认</option>
                        <option value="all">每步都确认</option>
                    </select>
                </label>
                <label class="sta-field sta-switch">
                    <span>聊天内注册工具</span>
                    <input class="sta-register-tools" type="checkbox" />
                </label>
                <div class="sta-hint">模型：默认用酒馆「API 连接」里的当前配置，不需要另建连接。<br>能力：<span class="sta-bridge-state">检测中…</span></div>
            </div>
        </section>
    `;
    document.body.appendChild(root);
    bindPanel(root);
    return root;
}

function bindPanel(root) {
    const panel = $('.sta-panel', root);
    const log = $('.sta-log', root);
    const input = $('.sta-input', root);
    const send = $('.sta-send', root);
    const stop = $('.sta-stop', root);
    const status = $('.sta-status', root);
    const drawer = $('.sta-drawer', root);
    const profileSel = $('.sta-profile', root);
    const maxSteps = $('.sta-maxsteps', root);
    const policy = $('.sta-approval-policy', root);
    const regTools = $('.sta-register-tools', root);

    currentView = { root, panel, log, input, send, stop, status, drawer, profileSel, maxSteps, policy, regTools };

    $('.sta-fab', root).addEventListener('click', () => togglePanel(true));
    $('.sta-close', root).addEventListener('click', () => togglePanel(false));
    $('.sta-gear', root).addEventListener('click', () => { drawer.hidden = !drawer.hidden; });
    $('.sta-drawer-close', root).addEventListener('click', () => { drawer.hidden = true; });

    send.addEventListener('click', submitTask);
    stop.addEventListener('click', () => abortController?.abort());
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submitTask();
        }
    });
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    });
    input.addEventListener('focus', () => root.classList.add('sta-mobile-focus'));

    profileSel.addEventListener('change', () => { settings.profileId = profileSel.value; saveSettings(); });
    maxSteps.addEventListener('change', () => { settings.maxSteps = Math.max(1, Number(maxSteps.value) || 20); saveSettings(); });
    policy.addEventListener('change', () => { settings.approval = policy.value; saveSettings(); });
    regTools.addEventListener('change', () => { settings.registerChatTools = regTools.checked; saveSettings(); registerChatTools(); });
}

function buildMenuEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        setTimeout(buildMenuEntry, 600);
        return;
    }
    if (menu.querySelector('.sta-menu-item')) return;
    const item = document.createElement('div');
    item.className = 'list-group-item flex-container flexGap5 interactable sta-menu-item';
    item.innerHTML = '<div class="fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton"></div><span>ST Agent</span>';
    item.title = 'ST Agent · 在酒馆内自主执行的 Agent';
    item.addEventListener('click', () => togglePanel(true));
    menu.appendChild(item);
    new MutationObserver(() => {
        if (!menu.querySelector('.sta-menu-item')) buildMenuEntry();
    }).observe(menu, { childList: true });
}

function togglePanel(open) {
    const { panel, root } = currentView;
    panel.classList.toggle('sta-open', open);
    root.classList.toggle('sta-panel-open', open);
    panel.setAttribute('aria-hidden', String(!open));
    document.body.classList.toggle('sta-lock', open);
    if (open && !matchMedia('(max-width: 720px)').matches) currentView.input.focus();
}

function setBusy(busy) {
    currentView.send.hidden = busy;
    currentView.stop.hidden = !busy;
    currentView.input.disabled = busy;
}

function updateStatus(text) {
    if (!currentView) return;
    currentView.status.textContent = text;
    currentView.root.classList.toggle('sta-offline', /离线|失败/.test(text));
}

function addLog(type, text, meta = '', state = '') {
    const entry = document.createElement('div');
    entry.className = `sta-log-item sta-${type} ${state ? 'sta-' + state : ''}`;
    const head = document.createElement('div');
    head.className = 'sta-log-head';
    head.textContent = type === 'user' ? '你' : type === 'final' ? 'Agent' : type === 'plan' ? '计划' : type === 'error' ? '异常' : '工具';
    const body = document.createElement('div');
    body.className = 'sta-log-body';
    body.textContent = text;
    entry.append(head, body);

    let details = null;
    const api = {
        setResult(payload, ok) {
            if (!details) {
                details = document.createElement('details');
                details.className = 'sta-tool-result';
                details.innerHTML = '<summary>查看结果</summary>';
                const pre = document.createElement('pre');
                details.appendChild(pre);
                entry.appendChild(details);
            }
            details.querySelector('pre').textContent = payload;
            entry.classList.toggle('sta-tool-ok', ok);
            entry.classList.toggle('sta-tool-fail', !ok);
            body.textContent = text;
            entry.dataset.status = ok ? 'ok' : 'fail';
        },
    };
    if (meta) body.textContent = `${text}  ${meta}`;
    currentView.log.appendChild(entry);
    currentView.log.scrollTop = currentView.log.scrollHeight;
    return api;
}

function addStreamingDraft() {
    const el = document.createElement('div');
    el.className = 'sta-log-item sta-stream';
    el.innerHTML = '<div class="sta-log-head">Agent</div><div class="sta-log-body"></div>';
    currentView.log.appendChild(el);
    currentView.log.scrollTop = currentView.log.scrollHeight;
    const body = el.querySelector('.sta-log-body');
    const timer = setInterval(() => { currentView.log.scrollTop = currentView.log.scrollHeight; }, 200);
    return {
        body,
        cleanup() {
            clearInterval(timer);
            el.remove();
        },
    };
}

function askApproval(call) {
    return new Promise(resolve => {
        const box = currentView.root.querySelector('.sta-approval');
        box.hidden = false;
        box.querySelector('.sta-approval-text').textContent = `待批准：${call.name}  ${summarizeArgs(call.args)}`;
        const allow = box.querySelector('.sta-allow');
        const deny = box.querySelector('.sta-deny');
        const cleanup = value => {
            box.hidden = true;
            allow.removeEventListener('click', onAllow);
            deny.removeEventListener('click', onDeny);
            resolve(value);
        };
        const onAllow = () => cleanup(true);
        const onDeny = () => cleanup(false);
        allow.addEventListener('click', onAllow);
        deny.addEventListener('click', onDeny);
    });
}

function submitTask() {
    if (running) return;
    const text = currentView.input.value.trim();
    if (!text) return;
    currentView.input.value = '';
    currentView.input.style.height = 'auto';
    runAgent(text);
}

function populateProfiles() {
    if (!currentView) return;
    const list = getProfiles();
    const sel = currentView.profileSel;
    sel.innerHTML = '';
    // 第一项永远是「当前酒馆 API」：直接用「API 连接」里配置的模型与密钥
    const current = document.createElement('option');
    current.value = "";
    const apiLabel = (() => {
        try {
            const oai = ctx().oai_settings || {};
            const model = oai.chat_completion_source === 'openai' ? oai.openai_model : (oai.oai_settings?.custom_model || '酒馆主 API');
            return `当前酒馆 API${model ? '（' + model + '）' : ''}`;
        } catch {
            return '当前酒馆 API';
        }
    })();
    current.textContent = apiLabel;
    sel.appendChild(current);

    for (const p of list) {
        const option = document.createElement('option');
        option.value = p.id;
        option.textContent = `${p.name || p.model || p.id}${p.model ? ' · ' + p.model : ''}`;
        sel.appendChild(option);
    }
    const valid = settings.profileId && list.some(p => p.id === settings.profileId);
    sel.value = valid ? settings.profileId : '';
    settings.profileId = sel.value;
}

function syncSettingsUI() {
    if (!currentView) return;
    currentView.maxSteps.value = settings.maxSteps;
    currentView.policy.value = settings.approval;
    currentView.regTools.checked = !!settings.registerChatTools;
}

/* ------------------------------ 聊天内工具注册 ------------------------------ */

function registerChatTools() {
    const c = ctx();
    if (!c.registerFunctionTool) return;
    for (const tool of activeTools()) {
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

/* ------------------------------ 初始化 ------------------------------ */

async function refreshBridgeState() {
    const online = await pingBridge();
    if (currentView) {
        currentView.root.querySelector('.sta-bridge-state').textContent = online
            ? '酒馆内工具 + 磁盘桥接（可读写任意文件、跑命令）'
            : '酒馆内工具（角色卡 / 世界书 / 聊天 / 设置 / 正则 / STscript）';
        updateStatus('就绪');
    }
    return online;
}

function initialize() {
    loadSettings();
    // 调试 / 二次开发出口
    window.STAgent = {
        run: runAgent,
        executeTool,
        parseToolCalls,
        get tools() { return activeTools(); },
        mockGenerate: fn => { generateOverride = fn; },
        get settings() { return settings; },
        stop: () => abortController?.abort(),
        open: () => togglePanel(true),
        close: () => togglePanel(false),
    };
    if (!settings.enabled) return;
    if (document.querySelector('.sta-root')) return; // 幂等：避免重复加载时叠加面板
    buildPanel();
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

jQuery(async () => {
    try {
        console.log('[st-agent] booting…');
        initialize();
        console.log('[st-agent] booted. panel =', !!document.querySelector('.sta-panel'));
    } catch (error) {
        console.error('[st-agent] 初始化失败:', error);
    }
});
