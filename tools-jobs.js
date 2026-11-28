import { listJobs, jobOutput, jobKill, JOB_LIMITS } from './index-jobs.js';

/**
 * 后台作业三件套（对标 DSH 的 job_output / job_list / job_kill）
 * 三个都标 read：它们只读/取消我们自己的后台作业，不碰用户的卡，不该被计划门或子任务只读规则挡住。
 */

export const TOOLS = [
    {
        name: 'job.list',
        kind: 'read',
        desc: '列当前所有后台作业（一行一个）：id [kind] status — label。status 只有 running / done / failed / cancelled。'
            + '每起一个 wait:false 的子任务就等于起了一个作业，先 list 再决定读还是杀。',
        params: {},
        run: async () => {
            const jobs = listJobs();
            const text = jobs.length
                ? jobs.map(j => `${j.id} [${j.kind}] ${j.status} — ${j.label}${j.detail ? `（${j.detail}）` : ''}`).join('\n')
                : '(no background jobs)';
            return { ok: true, text, count: jobs.length, jobs };
        },
    },
    {
        name: 'job.output',
        kind: 'read',
        desc: '读后台作业的输出：**消费式**——只返回自上次读取以来的增量，末尾带 [status: ...]。'
            + `wait:true 会等到作业结算或超时（默认 ${JOB_LIMITS.DEFAULT_WAIT_MS / 1000}s，上限 ${JOB_LIMITS.MAX_WAIT_MS / 1000}s）；超时返回 [status: running] 但**不杀作业**，之后还能再读。`
            + '不要在循环里反复读同一个作业（那是轮询，白烧上下文）：等它结算，或去干别的，完成时结论会自动落进会话。',
        params: {
            id: 'string 作业 id（就是子任务名）',
            wait: 'boolean 可选，true 表示等它结算（建议只在真的被它挡住时才用）',
            timeout_ms: 'number 可选，等待上限，默认 30000，最大 600000',
        },
        run: async a => {
            const got = await jobOutput(a);
            return { ok: true, ...got };
        },
    },
    {
        name: 'job.kill',
        kind: 'read',
        desc: '请求取消一个还在跑的后台作业（真正停下才结算为 cancelled，原因是记录并被转发）。已经结束的作业返回 already-finished，不再动它。',
        params: {
            id: 'string 作业 id',
            reason: 'string 可选，为什么不要它了（会记进作业状态）',
        },
        run: async a => {
            const got = jobKill(a);
            return { ok: true, ...got };
        },
    },
];
