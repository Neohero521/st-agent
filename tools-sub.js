import { spawnSub, continueSub, cancelSub, listSubs, getSub, SUB_LIMITS } from './index-sub.js';
import { uiHooks } from './index-state.js';

/**
 * 面向模型的委派工具（对标 DSH 的 tool-subagent + tool-subagent-control）
 *
 * 与 DSH 的差别只在「等不等」：DSH 的 subagent 永远不等，靠完成通知；
 * 我们默认等（手机端一个生成通道，等结果最稳），wait:false 才切成「起个名字就走」。
 * 语义上该抄的都抄了：子任务看不见主对话、深度 1、名称唯一且不能叫 lead、
 * 子任务里不能用 plan.*（未决决策必须写进结论）。
 */

function brief(sub) {
    return {
        name: sub.name,
        status: sub.status,
        steps: sub.steps,
        tools: sub.toolsUsed,
        ms: (sub.endedAt || Date.now()) - (sub.startedAt || Date.now()),
        parent: sub.parentId || undefined,
        error: sub.error || undefined,
    };
}

function clip(text, limit) {
    const s = String(text || '');
    return s.length > limit ? s.slice(0, limit) + `…（已截断，原长 ${s.length}）` : s;
}

export const TOOLS = [
    {
        name: 'sub.spawn',
        kind: 'write',
        desc: '把一件事单独交给一个子任务去做，子任务看不到当前对话、有自己的上下文，做完把结论交回来。'
            + '适合：independent 的调研/核对/批量读取（「把这 5 个文件里的字段捞出来」「核这张卡 MVU 八条齐不齐」）；'
            + '不适合：要跟用户来回确认的事、需要主对话上下文才能判断的事（子任务只能看到你写的 task）。'
            + '默认 wait=true 当场返回结论（手机端最稳）；wait=false 只返回 started subagent <name>，之后用 sub.result 取。'
            + '默认子任务只读（allowWrite=false）：允许它写卡/写世界书要显式传 allowWrite=true —— 那次调用本身会走批准，等于一次性授权这类写活。'
            + `同时最多 ${SUB_LIMITS.MAX_RUNNING} 个子任务，子任务不能再派子任务。`,
        params: {
            description: 'string 3-5 个词说清要干什么（给人看，进日志）',
            task: 'string 完整指令：目标、范围、验收标准、已知约束。子任务看不到主对话，缺什么就写什么',
            name: 'string 可选，子任务名（父级用它对账），默认 agent-1、agent-2…；不能叫 lead',
            wait: 'boolean 可选，默认 true：等它跑完再返回结论；false 则立即返回 started',
            allowWrite: 'boolean 可选，默认 false：子任务是否允许写酒馆（写卡/世界书/脚本/正则）',
        },
        run: async a => {
            const parent = uiHooks.getSession ? uiHooks.getSession() : null;
            const got = await spawnSub({
                task: a.task,
                name: a.name,
                parentId: parent?.id || '',
                wait: a.wait !== false,
                allowWrite: !!a.allowWrite,
            });
            const sub = got.sub;
            if (got.mode === 'started') {
                return {
                    ok: true,
                    delivered: `started subagent ${sub.name}`,
                    ...brief(sub),
                    hint: `它跑完之后结论会落在当前会话里；要主动拿就用 sub.result {"name":"${sub.name}"}。不要轮询。`,
                };
            }
            return {
                ok: sub.status === 'done',
                ...brief(sub),
                result: clip(sub.result || sub.error, SUB_LIMITS.MAX_RESULT_CHARS),
                hint: sub.status === 'done'
                    ? '结论已拿到。要落地就得自己复核（子任务也会看错），别原样转述给用户。'
                    : '子任务没跑成：看 error 决定自己接手还是换一种拆法。',
            };
        },
    },
    {
        name: 'sub.list',
        kind: 'read',
        desc: '列出本次会话里起过的子任务：名字、状态（running / done / failed / cancelled）、步数、工具次数、耗时、任务前 80 字、结论前 160 字。判断「要不要等」「哪个跑完了」先看它，别猜。',
        params: {},
        run: async () => {
            const list = listSubs();
            return { ok: true, total: list.length, running: list.filter(x => x.status === 'running').length, subs: list };
        },
    },
    {
        name: 'sub.result',
        kind: 'read',
        desc: '取一个子任务的完整结论（分段取：offset/limit）。还在 running 就返回当前状态；cancelled/failed 返回原因。长结论别让它在上下文里爆，先取前 2000 字看结论，细节再分段。',
        params: {
            name: 'string 子任务名',
            offset: 'number 可选，从第几个字符开始，默认 0',
            limit: 'number 可选，本次取多少字，默认 2000，上限 6000',
        },
        run: async a => {
            const sub = getSub(a.name);
            if (!sub) throw new Error(`没有子任务 ${a.name}（先用 sub.list 看有哪些）`);
            const text = String(sub.result || sub.error || '');
            const offset = Math.max(0, Number(a.offset) || 0);
            const limit = Math.min(6000, Math.max(200, Number(a.limit) || 2000));
            return {
                ok: sub.status === 'done',
                ...brief(sub),
                chars: text.length,
                offset,
                text: text.slice(offset, offset + limit),
                next: offset + limit < text.length ? offset + limit : null,
            };
        },
    },
    {
        name: 'sub.continue',
        kind: 'write',
        desc: '让一个已经结束的子任务接着做（它保留着上次的完整上下文），适合「差一点」「换个方向再来一次」。running 的不接受续跑；同名续跑会覆盖上一次记录。',
        params: {
            name: 'string 子任务名',
            instruction: 'string 续跑指令：补什么、改哪里、验收标准',
            wait: 'boolean 可选，默认 true',
        },
        run: async a => {
            const got = await continueSub({ name: a.name, instruction: a.instruction, wait: a.wait !== false });
            const sub = got.sub;
            if (got.mode === 'started') return { ok: true, delivered: `started subagent ${sub.name}（续跑）`, ...brief(sub) };
            return { ok: sub.status === 'done', ...brief(sub), result: clip(sub.result || sub.error, SUB_LIMITS.MAX_RESULT_CHARS) };
        },
    },
    {
        name: 'sub.cancel',
        kind: 'read',
        desc: '中止一个还在跑的子任务。已经结束的返回 false（没什么可中止的）。中止不会回滚它已经写下的东西——那些写活该 undo 的用 ops.undo。',
        params: { name: 'string 子任务名' },
        run: async a => {
            const done = cancelSub(a.name);
            const sub = getSub(a.name);
            return { ok: done, cancelled: done, ...(sub ? brief(sub) : { name: a.name }) };
        },
    },
];
