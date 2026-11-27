import { getContext } from '../../../extensions.js';
import { MODULE, BRIDGE_ID, DEFAULT_SETTINGS, settings, abortController, running, bridgeOnline, generateOverride, messages, currentView, setSettings, setAbortController, setRunning, setBridgeOnline, setMessages, setCurrentView, setGenerateOverride } from './index-state.js';
import { ctx, loadSettings, saveSettings, pingBridge, getProfiles, generateRawFn, getGenerateRaw, serializeHistory, rawGenerate } from './index-boot.js';
import { typewrite, MODEL_FIELD, buildChatPayload, streamChatCompletion } from './index-stream.js';
import { buildSystemPrompt } from './index-prompt.js';
import { parseToolCalls, repairJson, buildCall, extractFinal, sumChars, compactHistory, stepGenerate } from './index-loop.js';
import { HIGH_RISK_PATTERNS, RISK_META, riskOf, batchLines, executeTool, summarizeArgs, briefArgs } from './index-risk.js';
import { runAgent } from './index-agent.js';
import { html, buildPanel, bindPanel } from './index-ui.js';
import { askPlan, askApprovalBatch, askApproval, submitTask, populateProfiles, syncSettingsUI } from './index-ui3.js';
import { registerChatTools } from './index-tools.js';

/** 用户是不是还贴着底部在看。贴底才自动滚——不然往上翻历史会被一直拽回来。 */
function nearBottom(el) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 90;
}

function stickToBottom(force = false) {
    const log = currentView && currentView.log;
    if (!log) return;
    if (force || nearBottom(log)) log.scrollTop = log.scrollHeight;
}

export function buildMenuEntry() {
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

export function togglePanel(open) {
    const { panel, root } = currentView;
    panel.classList.toggle('sta-open', open);
    root.classList.toggle('sta-panel-open', open);
    panel.setAttribute('aria-hidden', String(!open));
    document.body.classList.toggle('sta-lock', open);
    if (open && !matchMedia('(max-width: 720px)').matches) currentView.input.focus();
}

export function setBusy(busy) {
    currentView.send.hidden = busy;
    currentView.stop.hidden = !busy;
    currentView.input.disabled = busy;
}

import { getPlan } from './index-plan.js';

export function paintPlanChip() {
    if (!currentView) return;
    const chip = currentView.root.querySelector('.sta-plan-chip');
    if (!chip) return;
    const p = getPlan();
    if (!p || !p.body) { chip.hidden = true; chip.textContent = ''; chip.className = 'sta-plan-chip'; return; }
    const label = { draft: '计划·草稿', pending: '计划·待批', approved: '计划·已批', rejected: '计划·退回' }[p.status] || '计划';
    chip.hidden = false;
    chip.textContent = label;
    chip.className = `sta-plan-chip sta-plan-${p.status}`;
}

export function updateStatus(text) {
    if (!currentView) return;
    currentView.status.textContent = text;
    currentView.root.classList.toggle('sta-offline', /离线|失败/.test(text));
    paintPlanChip();
}

export function addLog(type, text, meta = '', state = '', level = 0) {
    const entry = document.createElement('div');
    entry.className = `sta-log-item sta-${type} ${state ? 'sta-' + state : ''} ${level ? RISK_META[level].cls : ''}`;
    const head = document.createElement('div');
    head.className = 'sta-log-head';
    head.textContent = type === 'user' ? '你' : type === 'final' ? 'Agent' : type === 'plan' ? '计划' : type === 'error' ? '异常' : '工具';
    if (level) {
        const badge = document.createElement('span');
        badge.className = `sta-risk-badge ${RISK_META[level].cls}`;
        badge.textContent = RISK_META[level].label;
        head.appendChild(badge);
    }
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
        // 写类工具同步完酒馆界面后打个小标：用户一眼确认"确实刷了，不用再手动刷新"
        setRefresh(list) {
            if (!Array.isArray(list) || !list.length) return;
            const tag = document.createElement('div');
            tag.className = 'sta-refresh-note';
            tag.textContent = '已同步界面：' + list.join('、');
            entry.appendChild(tag);
        },
    };
    if (meta) body.textContent = `${text}  ${meta}`;
    currentView.log.appendChild(entry);
    stickToBottom();
    return api;
}

export function addStreamingDraft() {
    const el = document.createElement('div');
    el.className = 'sta-log-item sta-stream';
    el.innerHTML = `
        <div class="sta-log-head">Agent<span class="sta-stream-tag" hidden></span></div>
        <details class="sta-reasoning" hidden>
            <summary><span class="sta-reasoning-glow"></span><span class="sta-reasoning-title">思考中…</span></summary>
            <div class="sta-reasoning-body"></div>
        </details>
        <div class="sta-log-body"><span class="sta-caret"></span></div>`;
    currentView.log.appendChild(el);
    stickToBottom(true);

    const body = el.querySelector('.sta-log-body');
    const caret = el.querySelector('.sta-caret');
    const tag = el.querySelector('.sta-stream-tag');
    const reasoningBox = el.querySelector('.sta-reasoning');
    const reasoningTitle = el.querySelector('.sta-reasoning-title');
    const reasoningBody = el.querySelector('.sta-reasoning-body');

    const timer = setInterval(() => stickToBottom(), 200);
    let firstText = true;

    const api = {
        setText(text) {
            body.textContent = text;
            body.appendChild(caret);
            // 正文首字到达：思考行折叠，目光让给正文
            if (firstText && text) {
                firstText = false;
                if (!reasoningBox.hidden) {
                    reasoningBox.open = false;
                    reasoningBox.classList.add('sta-reasoning-done');
                    reasoningTitle.textContent = '思考过程';
                }
            }
        },
        setReasoning(text, done) {
            if (!text) return;
            if (reasoningBox.hidden) {
                reasoningBox.hidden = false;
                reasoningBox.open = true;
            }
            reasoningBody.textContent = text;
            if (done) {
                reasoningBox.classList.add('sta-reasoning-done');
                reasoningTitle.textContent = '思考过程';
            } else {
                // running 摘要：取最后一行，够长就截尾
                const tail = String(text).trim().split(String.fromCharCode(10)).filter(Boolean).pop() || '';
                reasoningTitle.textContent = tail.length > 48 ? '…' + tail.slice(-46) : (tail || '思考中…');
            }
        },
        finish(streamed) {
            if (streamed) {
                tag.hidden = false;
                tag.textContent = '流式';
            }
        },
        /**
         * 收尾：keep=true 保留正文（最终回复），keep=false 移除草稿（含 tool_call 的中间稿），
         * 但把思考行折叠成一条独立日志，不打断阅读。
         */
        finalize({ keep = false, text = '', reasoning = '' } = {}) {
            clearInterval(timer);
            caret.remove();
            if (keep) {
                body.textContent = text;
                // 没有思考内容就整块摘掉：留着空的 details 会在卡片里撑出一段空白
                if (!reasoningBox.hidden && reasoning) {
                    reasoningBox.open = false;
                    reasoningBox.classList.add('sta-reasoning-done');
                    reasoningTitle.textContent = '思考过程';
                } else {
                    reasoningBox.remove();
                }
                el.classList.remove('sta-stream');
                el.classList.add('sta-final');
                return;
            }
            el.remove();
            if (reasoning) {
                const item = document.createElement('details');
                item.className = 'sta-log-item sta-reasoning-item';
                item.innerHTML = '<summary><span class="sta-reasoning-title">思考过程</span></summary><div class="sta-reasoning-body"></div>';
                item.querySelector('.sta-reasoning-body').textContent = reasoning;
                currentView.log.appendChild(item);
                stickToBottom();
            }
        },
        cleanup() {
            clearInterval(timer);
            caret.remove();
            el.remove();
        },
    };
    return api;
}
