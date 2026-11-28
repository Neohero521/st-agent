import { board, teamEnabled, setTeamEnabled, createTask, listTasks, getTask, updateTask, teamBrief } from './index-team.js';
import { uiHooks } from './index-state.js';

/**
 * 共享任务板工具（对标 DSH 的 tool-agent-team 四个任务工具 + team/mode）
 *
 * 语义照抄：task-<n> 编号、revision 是 compare-and-set、blockedBy 保持无环、
 * writeScopes 只是提示不是锁、pending=未开始或已释放、deleted 保留墓碑。
 * 本地化：owner 用子任务名（sub.spawn 的 name）或 lead；任务板挂在会话上，刷新不丢。
 */

function who(caller) {
    return String(caller || 'lead');
}

export const TOOLS = [
    {
        name: 'team.mode',
        kind: 'read',
        desc: '开关共享任务板（默认开）。关掉只是不再往提示词里塞任务板摘要、不再鼓励派活，已有任务不会丢。',
        params: { enabled: 'boolean 可选，不传就只读当前状态' },
        run: async a => {
            const s = uiHooks.getSession ? uiHooks.getSession() : null;
            if (a.enabled === undefined) return { enabled: teamEnabled(s), brief: teamBrief(s) };
            return setTeamEnabled(!!a.enabled, s);
        },
    },
    {
        name: 'team.task.create',
        kind: 'read',
        desc: '在共享任务板上建一条任务（pending）。多子任务/多步骤协作时先建板再派活：谁负责哪块、先后顺序（blockedBy）、会碰哪些文件（writeScopes）。'
            + 'blockedBy 必须指向已存在的未删除任务，成环会被拒。writeScopes 只接受相对路径且不能含 ..，它是提示不是锁——重叠会给 warning。',
        params: {
            subject: 'string 一句话说清这条任务要产出什么',
            description: 'string 可选，验收标准与已知约束',
            blocked_by: 'array 可选，依赖的任务 id 列表（如 ["task-1"]），全部完成这条才算就绪',
            write_scopes: 'array 可选，会碰的相对路径前缀（如 ["cards/Seraphina","books/TestBook"]）',
            owner: 'string 可选，直接指定负责人（子任务名或 lead）',
        },
        run: async a => {
            const s = uiHooks.getSession ? uiHooks.getSession() : null;
            const v = createTask(a, s);
            return { ok: true, task: v, brief: teamBrief(s) };
        },
    },
    {
        name: 'team.task.list',
        kind: 'read',
        desc: '列共享任务板（默认只列未删除的，按创建顺序前 100 条）。开活前先 list 看哪条就绪、谁在做什么、有没有 writeScopes 重叠。',
        params: {
            status: 'string 可选，pending / in_progress / completed',
            unowned: 'boolean 可选，true 只看没人认领的，false 只看已分配的（不能和 owner 同时用）',
            owner: 'string 可选，只看某个负责人的任务',
            offset: 'number 可选，跳过多少条',
            limit: 'number 可选，默认 100，上限 100',
        },
        run: async a => {
            const s = uiHooks.getSession ? uiHooks.getSession() : null;
            const got = listTasks(a, s);
            return { ok: true, ...got };
        },
    },
    {
        name: 'team.task.get',
        kind: 'read',
        desc: '读一条任务的最新快照（含 revision、ready、blocked_by_open、writeScopeWarnings）。改动前必须先 get，拿当前 revision，否则会被 revision 过期挡回。',
        params: { id: 'string 任务 id，如 task-3' },
        run: async a => {
            const s = uiHooks.getSession ? uiHooks.getSession() : null;
            return { ok: true, task: getTask(a.id, s) };
        },
    },
    {
        name: 'team.task.update',
        kind: 'read',
        desc: '改一条任务。action：claim（认领，要求 pending 且就绪）/ start（开工）/ complete（完成，让下游就绪）/ release（放回 pending）/ reassign（换负责人）/ edit（改 subject/description/write_scopes/blocked_by）/ delete（置墓碑）。'
            + '带 revision 才做 compare-and-set：revision 不是当前值就拒绝，防止两个人同时改把状态写串。'
            + '约定流程：list → get(拿 revision) → claim → 干活 → complete。任务就绪不会自动唤醒负责人，该开工就用 sub.spawn 派。',
        params: {
            id: 'string 任务 id',
            revision: 'number 可选但强烈建议：你读到的 revision，和当前不一致会被拒',
            action: 'string claim / start / complete / release / reassign / edit / delete',
            owner: 'string 可选，claim / reassign 时指定负责人（默认 lead）',
            subject: 'string 可选，edit 用',
            description: 'string 可选，edit 用',
            write_scopes: 'array 可选，edit 用',
            blocked_by: 'array 可选，edit 用',
            caller: 'string 可选，谁在改（子任务名），默认 lead',
        },
        run: async a => {
            const s = uiHooks.getSession ? uiHooks.getSession() : null;
            const v = updateTask(a, { caller: a.caller || who(a.owner) }, s);
            return { ok: true, task: v, brief: teamBrief(s) };
        },
    },
];
