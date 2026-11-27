import { settings, uiHooks } from './index-state.js';

/**
 * 计划模式（对标 deepseek-harness 的 plan/plan-mode）
 *
 * DSH 的做法：会话里存一条「整值替换」的 plan/mode 事件，进入时注入一段 plan:policy 引导，
 * 退出靠 exit_plan_mode 工具把完整计划（markdown，必须以 # 标题开头）交给用户评审，
 * 用户 Approve 才离开计划阶段，Keep planning 则带着反馈退回继续改。状态可回放、压缩后仍在。
 *
 * 这里的差别只有一条，是故意反过来的：DSH 明确写着「引导而非强制」，plan 模式不拦任何工具；
 * 而我们这套是手机端、模型能力参差，软引导经常变成「嘴上说先规划、手已经在写卡」。
 * 所以加了硬门：一旦这份计划还没批准，写类工具直接被挡回来，只读工具照常放行。
 * 计划本身仍然是软引导（不阻止读、不阻止探索），只是「动手」这一下要过关。
 *
 * 存在会话上（session.plan），跟 todo / goal 同级：切会话就是另一份计划，刷新/重开会话还在。
 */

export const PLAN_POLICY = [
    '你在计划模式里。先把要改什么、按什么顺序改、每步怎么验收想清楚，写成一份可评审的计划，',
    '交给用户批准后再动手。这一段允许只读探索（char.get / world.get / script.list / chat.recent 这类），',
    '但不允许写盘：写类工具会被门挡回来，直到计划被批准。',
].join('\n');

/** 这些工具是「计划本身的入口」，不受门限制，否则计划永远批不出来 */
const GATE_EXEMPT = new Set([
    'plan.read', 'plan.write', 'plan.submit', 'plan.reset',
    'todo.write', 'goal.get', 'goal.create', 'goal.update',
    'session.list', 'session.peek', 'usage.get', 'spill.list', 'spill.read',
]);

const STATUS_LABEL = {
    draft: '草稿（还没提交评审）',
    pending: '待评审',
    approved: '已批准，可以动手',
    rejected: '被退回，需要按反馈继续改',
};

function blank() {
    return { status: 'draft', title: '', body: '', items: [], revision: 0, feedback: '', updatedAt: Date.now() };
}

function activeSession() {
    return uiHooks.getSession ? uiHooks.getSession() : null;
}

export function getPlan() {
    const session = activeSession();
    if (!session) return null;
    const p = session.plan;
    return p && typeof p === 'object' ? p : null;
}

export function setPlan(patch) {
    const session = activeSession();
    if (!session) throw new Error('还没有活动会话（先发一条任务，让插件建会话）');
    const prev = session.plan && typeof session.plan === 'object' ? session.plan : blank();
    const next = Object.assign({}, blank(), prev, patch, { updatedAt: Date.now() });
    if (patch && patch.body !== undefined) next.revision = (Number(prev.revision) || 0) + (patch.revisionBump === false ? 0 : 1);
    delete next.revisionBump;
    session.plan = next;
    // 计划改动立刻落盘：会话保存是节流的，刷新页面时刚写的计划会丢
    try { uiHooks.flush?.(); } catch (e) { console.warn('[st-agent] 计划落盘失败：', e && e.message); }
    try { uiHooks.paintPlan?.(); } catch { /* 面板没建时忽略 */ }
    return next;
}

export function clearPlan() {
    const session = activeSession();
    if (!session) return null;
    const before = session.plan;
    delete session.plan;
    try { uiHooks.flush?.(); } catch (e) { console.warn('[st-agent] 计划落盘失败：', e && e.message); }
    try { uiHooks.paintPlan?.(); } catch { /* 面板没建时忽略 */ }
    return before || null;
}

/** 每轮贴在 system 末尾的一行状态（DSH 的 plan:status 等价物） */
export function planStatusLine() {
    const p = getPlan();
    if (!settings.planMode && !p) return '';
    if (!p || !p.body) return settings.planMode ? '计划模式：开（还没写计划。写盘前先 plan.write + plan.submit）' : '';
    const label = STATUS_LABEL[p.status] || p.status;
    const gate = p.status === 'approved' ? '' : '；写类工具当前被挡住';
    return `计划：${p.title || '(未命名)'}（${label}，rev ${p.revision}${gate}）`;
}

/** 计划正文：只在未批准时注入，避免批准后每轮重复占上下文 */
export function planBlock() {
    const p = getPlan();
    if (!p || !p.body) return '';
    if (p.status === 'approved') return '';
    return `\n\n<plan status="${p.status}" revision="${p.revision}">\n${p.body}\n</plan>`;
}

/**
 * 写盘门。返回 null 表示放行；返回对象表示拒绝（直接当工具结果回给模型）。
 * level 来自 riskOf：1 只读、2 写、3 高危。
 */
export function planGate(name, level) {
    if (!settings.planMode) return null;
    if (GATE_EXEMPT.has(String(name))) return null;
    if ((level || 1) < 2) return null;
    const p = getPlan();
    if (!p || !p.body) return null; // 没写过计划就不门，别打断日常使用
    if (p.status === 'approved') return null;
    return {
        ok: false,
        blocked: true,
        error: `计划还没批准（${STATUS_LABEL[p.status] || p.status}）：${p.title || '(未命名计划)'}。`
            + '先 plan.write 把计划写完、plan.submit 交给用户批；只读工具（char.get / world.get / script.list 等）不受限制。',
    };
}
