/**
 * goal —— 照搬 deepseek-harness `packages/goal/goal` 的约定：
 * 每个会话只有「一个当前目标」，四种持久 phase（active / paused / blocked / complete），
 * 每次变更走 revision 的比较并设置（带旧 revision 的变更被明确拒绝，而不是静默覆盖），
 * 只有 Round 数量预算（默认 256），服务只存状态、不调度工作——
 * 真正「继续跑」由续接/自动续行那套去消费这个状态。
 */
import { getActiveSession } from './index-sessions.js';

export const GOAL_DEFAULT_MAX_ROUNDS = 256;

const PHASES = ['active', 'paused', 'blocked', 'complete'];
const VERBS = ['create', 'edit', 'pause', 'resume', 'complete', 'block', 'clear'];

export function getGoal(session) {
    const s = session || getActiveSession();
    const g = s && s.goal;
    if (!g) return null;
    return {
        id: g.id,
        objective: g.objective,
        phase: g.phase,
        revision: g.revision,
        roundsStarted: g.roundsStarted || 0,
        maxGoalRounds: g.maxGoalRounds || GOAL_DEFAULT_MAX_ROUNDS,
        blocker: g.blocker || null,
        createdAt: g.createdAt || '',
        updatedAt: g.updatedAt || '',
    };
}

function stamp() {
    try { return new Date().toISOString(); } catch { return ''; }
}

function need(title, note) {
    const error = new Error(`${title}${note ? `：${note}` : ''}`);
    error.code = 'GOAL_INVALID';
    return error;
}

/**
 * 一次变更。verb 取 VERBS 之一；opts: { objective, maxGoalRounds, revision, blockerCode, blockerNote }
 * clear 会把 goal 移除并留 tombstone（保留 revision，历史不丢）。
 */
export function changeGoal(verb, opts = {}) {
    const s = getActiveSession();
    if (!s) throw need('当前没有会话');
    const v = String(verb || '');
    if (!VERBS.includes(v)) throw need(`不认识的 goal 操作 "${v}"`, `只支持 ${VERBS.join(' / ')}`);
    const now = stamp();

    if (v === 'create') {
        const goal = s.goal;
        if (goal && goal.phase !== 'complete') {
            throw need('已有一个未完成的 goal', '先 edit / pause / resume / block / clear 掉它，才能建新的');
        }
        const objective = String(opts.objective || '').trim();
        if (!objective) throw need('create 需要 objective');
        const rounds = opts.maxGoalRounds === undefined ? GOAL_DEFAULT_MAX_ROUNDS : Number(opts.maxGoalRounds);
        if (!Number.isSafeInteger(rounds) || rounds <= 0) throw need('maxGoalRounds 必须是正整数');
        s.goalSeq = (Number(s.goalSeq) || 0) + 1;
        s.goal = {
            id: `g${s.goalSeq}`,
            objective,
            phase: 'active',
            revision: 1,
            roundsStarted: 0,
            maxGoalRounds: rounds,
            blocker: null,
            createdAt: now,
            updatedAt: now,
        };
        return getGoal(s);
    }

    const goal = s.goal;
    if (!goal) throw need(`没有可 ${v} 的 goal`);
    // 比较并设置：带着旧 revision 的调用方必须拿到清晰的陈旧错误
    if (opts.revision !== undefined && Number(opts.revision) !== Number(goal.revision)) {
        throw need(`revision 已过期（当前 ${goal.revision}，收到 ${opts.revision}）`, '用 goal.get 重新读一次当前状态再改');
    }
    if (goal.phase === 'complete' && v !== 'clear') throw need('goal 已完成', '要开新目标请 create，或先 clear');

    if (v === 'clear') {
        s.goalTombstone = { id: goal.id, revision: goal.revision + 1, at: now };
        s.goal = null;
        return null;
    }
    if (v === 'edit') {
        if (opts.objective !== undefined) {
            const objective = String(opts.objective).trim();
            if (!objective) throw need('edit 的 objective 不能为空');
            goal.objective = objective;
        }
        if (opts.maxGoalRounds !== undefined) {
            const rounds = Number(opts.maxGoalRounds);
            if (!Number.isSafeInteger(rounds) || rounds <= 0) throw need('maxGoalRounds 必须是正整数');
            goal.maxGoalRounds = rounds;
        }
    } else if (v === 'pause') {
        if (goal.phase !== 'active') throw need(`只有 active 能 pause（当前 ${goal.phase}）`);
        goal.phase = 'paused';
    } else if (v === 'resume') {
        if (goal.phase !== 'paused' && goal.phase !== 'blocked') {
            throw need(`只有 paused / blocked 能 resume（当前 ${goal.phase}）`);
        }
        if ((goal.roundsStarted || 0) >= goal.maxGoalRounds) throw need('Round 预算已用完', '先 edit 把 maxGoalRounds 调大');
        goal.phase = 'active';
        goal.blocker = null;
    } else if (v === 'complete') {
        goal.phase = 'complete';
    } else if (v === 'block') {
        const code = String(opts.blockerCode || '').trim();
        if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(code)) {
            throw need('block 需要一个 lower-kebab-case 的 blockerCode', '例如 budget-exhausted / needs-user-input');
        }
        goal.phase = 'blocked';
        goal.blocker = { code, note: String(opts.blockerNote || '').slice(0, 400) };
    } else {
        throw need(`不认识的 goal 操作 "${v}"`);
    }
    goal.revision += 1;
    goal.updatedAt = now;
    return getGoal(s);
}

/** 供自动续行判断：还有 Round 余量且处于 active。 */
export function goalShouldContinue(session) {
    const g = getGoal(session);
    return !!g && g.phase === 'active' && (g.roundsStarted || 0) < g.maxGoalRounds;
}

/** 每次真的续了一轮就记一次 Round（续行预算靠它约束）。 */
export function noteGoalRound(session) {
    const s = session || getActiveSession();
    if (!s || !s.goal) return null;
    s.goal.roundsStarted = (Number(s.goal.roundsStarted) || 0) + 1;
    s.goal.revision += 1;
    s.goal.updatedAt = stamp();
    return getGoal(s);
}

export const GOAL_PHASES = PHASES;
