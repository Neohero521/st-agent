import { OPS_LIMIT, LEVEL_LABEL, clone } from './v20-lib.js';
import { CATALOG } from './v20-catalog-a.js';
import { normalizeOps, planOps, newId, PLANS, JOURNALS, opsHash, takeSnapshots } from './v20-plan.js';

export async function opsCatalog() {
    return {
        limit: OPS_LIMIT,
        undoable: ['world', 'char', 'setting'],
        items: [...CATALOG.values()].map(s => ({ tool: s.tool, level: s.level, risk: LEVEL_LABEL[s.level], undo: s.undo })),
    };
}

export async function opsPlan(a) {
    const ops = normalizeOps(a.ops);
    if (!ops.length) throw new Error('ops 为空');
    const plan = await planOps(ops);
    const planId = newId('plan');
    const usable = ops.slice(0, OPS_LIMIT);
    PLANS.set(planId, { id: planId, at: Date.now(), hash: opsHash(usable), ops: clone(usable), items: plan.items });
    // 只保留最近 20 个预演，避免内存无限增长
    if (PLANS.size > 20) {
        const oldest = PLANS.keys().next().value;
        PLANS.delete(oldest);
    }
    return Object.freeze({
        ok: plan.errors.length === 0 && plan.truncated === 0,
        planId,
        total: ops.length,
        willApply: plan.items.filter(it => it.change !== 'blocked' && it.change !== 'error').length,
        counts: plan.counts,
        highestRisk: LEVEL_LABEL[plan.highest] || 'none',
        truncated: plan.truncated,
        errors: plan.errors,
        items: plan.items,
        note: '预演不写盘。执行请调用 ops.apply 并带上 planId。',
    });
}

export async function opsApply(a) {
    const ops = normalizeOps(a.ops);
    if (!ops.length) throw new Error('ops 为空');

    if (ops.length > OPS_LIMIT) {
        const dropped = ops.length - OPS_LIMIT;
        return Object.freeze({
            ok: false,
            truncated: dropped,
            error: `本批 ${ops.length} 条超过上限 ${OPS_LIMIT}，后 ${dropped} 条未执行。请分多轮小批量提交。`,
        });
    }

    if (a.planId) {
        const plan = PLANS.get(String(a.planId));
        if (!plan) throw new Error(`预演已过期或不存在：${a.planId}`);
        if (plan.hash !== opsHash(ops)) {
            throw new Error('参数与预演时不一致（planId 校验失败）。请重新 ops.plan 后再执行。');
        }
    }

    const exec = window.STAgent?.executeTool;
    if (typeof exec !== 'function') throw new Error('工具执行器不可用（window.STAgent.executeTool 未就绪）');

    const startedAt = Date.now();
    const snapshots = await takeSnapshots(ops).catch(() => []);
    const journalId = newId('ops');
    const items = [];
    const errors = [];
    const warnings = [];
    let applied = 0;
    let failed = 0;
    let skipped = 0;

    // 同批次连续相同操作告警（模型死磕同一个坑）
    let lastSig = '';
    let repeatCount = 0;
    const sigCache = new Map();

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i] || {};
        const tool = String(op.tool || op.name || '');
        let args = op.args ?? op.arguments ?? {};
        if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { args = {}; }
        }
        const spec = CATALOG.get(tool);

        if (!spec) {
            skipped++;
            const message = `不允许批处理的工具：${tool || '(空)'}`;
            errors.push({ i, tool, message });
            items.push(Object.freeze({ i, tool, ok: false, skipped: true, error: message }));
            continue;
        }

        const sig = `${tool}:${JSON.stringify(args)}`;
        const times = (sigCache.get(sig) || 0) + 1;
        sigCache.set(sig, times);
        if (sig === lastSig) repeatCount++;
        else { lastSig = sig; repeatCount = 1; }
        if (repeatCount === 3) {
            warnings.push(`第 ${i + 1} 条：同一操作已连续出现 3 次（${tool}），确认不是死磕同一处？`);
        }

        try {
            const result = await exec({ name: tool, args });
            applied++;
            items.push(Object.freeze({
                i,
                tool,
                ok: true,
                target: spec.target(args),
                level: spec.level,
                result: typeof result === 'string' ? result.slice(0, 600) : clone(result),
            }));
        } catch (error) {
            failed++;
            errors.push({ i, tool, message: error.message });
            items.push(Object.freeze({
                i,
                tool,
                ok: false,
                target: spec.target(args),
                level: spec.level,
                error: error.message,
            }));
        }
    }

    const journal = {
        id: journalId,
        at: startedAt,
        ms: Date.now() - startedAt,
        ops: clone(ops),
        snapshots,
        applied,
        failed,
        skipped,
        undoneAt: null,
    };
    JOURNALS.push(journal);
    if (JOURNALS.length > 10) JOURNALS.shift();

    const receipt = Object.freeze({
        ok: failed === 0 && skipped === 0,
        journal: journalId,
        total: ops.length,
        applied,
        failed,
        skipped,
        ms: Date.now() - startedAt,
        undoable: snapshots.map(s => `${s.kind}:${s.name || s.path}`),
        warnings,
        errors,
        items,
        note: failed || skipped ? '部分失败：见 errors，其余已成功落盘。可用 ops.undo 回滚可回滚项。' : '全部完成。',
    });
    // 预演用过一次即失效，避免拿旧 planId 再执行一批不同内容
    if (a.planId) PLANS.delete(String(a.planId));
    return receipt;
}

export async function opsJournals(a) {
    if (a.id) {
        const hit = JOURNALS.find(j => j.id === a.id);
        if (!hit) throw new Error(`没有这个批次：${a.id}`);
        return hit;
    }
    return JOURNALS.map(j => ({
        id: j.id,
        at: new Date(j.at).toLocaleString(),
        total: j.ops.length,
        applied: j.applied,
        failed: j.failed,
        skipped: j.skipped,
        undoable: j.snapshots.map(s => `${s.kind}:${s.name || s.path}`),
        undone: !!j.undoneAt,
    }));
}
