import { getPlan, setPlan, clearPlan, planStatusLine, planBlock, planGate, PLAN_POLICY } from './index-plan.js';
import { abortController, uiHooks } from './index-state.js';

/**
 * 计划模式的四个入口（对齐 DSH plan-mode 的「写 → 提交 → 评审 → 退出」）
 *
 * plan.write  ：把计划整份写进会话（既往计划整表替换，不追加）
 * plan.read   ：回读状态（草稿 / 待评审 / 已批准 / 被退回）
 * plan.submit ：提交评审，弹批准卡；用户批准才转 approved，写盘门随之放开
 * plan.reset  ：清掉这份计划（批准后收尾、或换活重来）
 */

function summarize(plan) {
    const items = Array.isArray(plan?.items) ? plan.items : [];
    return {
        status: plan?.status || null,
        title: plan?.title || '',
        revision: plan?.revision || 0,
        items: items.length,
        pendingItems: items.filter(x => (x?.status || 'pending') !== 'completed').length,
        bodyChars: String(plan?.body || '').length,
        feedback: plan?.feedback || '',
    };
}

export const TOOLS = [
    {
        name: 'plan.read',
        kind: 'read',
        desc: '读当前会话的计划：状态（draft 草稿 / pending 待评审 / approved 已批准 / rejected 被退回）、revision、条目进度、正文长度、上次被退回时的反馈。计划与 todo 不是一回事：todo 是执行中的勾选清单，plan 是动手前要过评审的整体方案。',
        params: {},
        run: async () => {
            const plan = getPlan();
            return {
                ok: true,
                plan: summarize(plan),
                body: plan?.body || '',
                statusLine: planStatusLine(),
                gate: planGate('char.edit', 2) ? '写类工具当前被挡（计划未批准）' : '写类工具放行',
                hint: plan?.body ? '要改就整份重写（plan.write），不要只补一句。' : '还没写计划。先 plan.write。',
            };
        },
    },
    {
        name: 'plan.write',
        kind: 'write',
        desc: '把这次活儿的整体计划写进会话（整份替换，不追加）。body 是给人评审的 markdown，**必须以 # 标题开头**（与 DSH 的 exit_plan_mode 校验同款），写清：要改哪些对象、按什么顺序、每步怎么验收、哪一步可能回滚。写完之后必须 plan.submit 交给用户批，批准前写类工具会被门挡住。',
        params: {
            title: 'string 计划标题（短，一句话说清要干什么）',
            body: 'string 完整计划 markdown，必须以 # 开头',
            items: 'array 可选，计划条目 [{ content, status? }]，status 取 pending / in_progress / completed',
        },
        run: async a => {
            const title = String(a.title || '').trim();
            const body = String(a.body || '').trim();
            if (!body) throw new Error('body 为空：计划正文不能空着提交');
            if (!/^#/.test(body)) throw new Error('计划正文必须以 # 标题开头（评审时按 markdown 渲染，没有标题的计划会被退回）');
            const items = Array.isArray(a.items)
                ? a.items.map(x => ({
                    content: String(x?.content || '').trim(),
                    status: ['pending', 'in_progress', 'completed'].includes(x?.status) ? x.status : 'pending',
                })).filter(x => x.content)
                : [];
            const plan = setPlan({ title: title || '本轮计划', body, items, status: 'draft', feedback: '' });
            return {
                ok: true,
                plan: summarize(plan),
                next: 'plan.submit 提交评审；批准后写类工具才放行。',
            };
        },
    },
    {
        name: 'plan.submit',
        kind: 'write',
        desc: '把写好的计划提交给用户评审（等价于 DSH 的 exit_plan_mode）：会弹一张批准卡，批准后计划转 approved、写盘门放开；不批准则退回 rejected，你按反馈继续改计划再提交。计划正文会随卡呈现，所以提交前一定自己先读一遍。',
        params: {},
        run: async () => {
            const plan = getPlan();
            if (!plan || !plan.body) throw new Error('还没有计划可提交：先 plan.write');
            if (!/^#/.test(plan.body)) throw new Error('计划正文必须以 # 标题开头，先 plan.write 改掉再提交');

            const review = uiHooks.askPlanReview || uiHooks.askApproval;
            if (!review) throw new Error('当前没有可用的批准通道：面板还没初始化完，稍后重试');
            setPlan({ status: 'pending' });
            const approved = uiHooks.askPlanReview
                ? await uiHooks.askPlanReview(getPlan(), abortController?.signal)
                : await uiHooks.askApproval({ name: 'plan.submit', args: { 计划: plan.title || '(未命名)' } }, abortController?.signal);
            if (approved) {
                const done = setPlan({ status: 'approved', feedback: '' });
                return { ok: true, approved: true, plan: summarize(done), hint: '已批准，现在可以写盘了。' };
            }
            const back = setPlan({ status: 'rejected', feedback: '用户没有批准这份计划' });
            return {
                ok: false,
                approved: false,
                plan: summarize(back),
                hint: '用户没批准。按他的意见改计划（plan.write 整份重写）后再 plan.submit，不要绕过评审直接写盘。',
            };
        },
    },
    {
        name: 'plan.reset',
        kind: 'write',
        desc: '清掉本会话的计划（批准后收尾、或整活换方向时用）。清掉之后写盘门不再生效。',
        params: {},
        run: async () => {
            const before = clearPlan();
            return { ok: true, cleared: !!before, plan: summarize(before), statusLine: planStatusLine() };
        },
    },
    {
        name: 'plan.policy',
        kind: 'read',
        desc: '读计划模式的引导原文（DSH plan:policy 的等价物）。不确定在计划模式下该怎么配合时先读它，别凭印象。',
        params: {},
        run: async () => ({ ok: true, policy: PLAN_POLICY, block: planBlock() || '(当前没有未批准的计划正文)' }),
    },
];
