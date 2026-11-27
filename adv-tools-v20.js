/**
 * v1.10 工具层：批量操作块执行器。
 *
 * 借鉴自家写卡器 v329.59（3MB 单文件那份）里的 applyOps / _opsPipeline：
 *   1. 一次提交多条写操作（世界书条目、角色字段、设置键、正则…），而不是一条一个 tool_call；
 *   2. 执行前先「预演」：校验目标、预测 create/update/delete/noop、算字段差异，不写盘；
 *   3. 执行时逐条 try/catch 隔离——单条失败只进 errors，不中断整批（写卡器 v221 的教训：
 *      不隔离就会出现「输出了文字、结束后报错、内容丢失」）；
 *   4. 执行前对涉及的目标做快照，支持按批次逆序回滚（写卡器只有 diff，没有 undo，这里补上）；
 *   5. 单批上限 40 条，超限直接截断并返回结构化错误（harness timeout-policy 同款：报错而不是挂死）；
 *   6. 同批次内连续 3 次相同操作告警（模型死磕同一个坑），跨批次不累计；
 *   7. 回执 Object.freeze() 冻结，避免上层 UI 二次改写后与真实结果不一致。
 *
 * 设计边界：批处理只接受「语义写工具」，不接受 exec / fs.* / extension.install 这类
 * 有外部副作用、无法可靠回滚的操作——那些继续单条走，由审批层逐条确认。
 *
 * v1.11 模块化拆分：本文件只留工具壳，实现在 v20-lib / v20-catalog-a / v20-catalog-b /
 * v20-plan / v20-apply / v20-undo 六个模块。
 */
import { OPS_LIMIT } from './v20-lib.js';
import { opsCatalog, opsPlan, opsApply, opsJournals } from './v20-apply.js';
import { opsUndo } from './v20-undo.js';

/* ------------------------------ 工具 ------------------------------ */

export const TOOLS = [
    {
        name: 'ops.catalog',
        kind: 'read',
        desc: '列出可批处理的写工具：风险等级、是否可回滚、单批上限。批处理前先看这个。',
        params: {},
        run: () => opsCatalog(),
    },
    {
        name: 'ops.plan',
        kind: 'read',
        desc: '预演一批操作：校验目标是否存在、预测 create/update/delete/noop、列出字段变化与警告。不写盘，返回 planId。',
        params: { ops: 'array 操作数组，元素 {"tool":"工具名","args":{...},"why":"可选说明"}' },
        run: a => opsPlan(a),
    },
    {
        name: 'ops.apply',
        kind: 'write',
        desc: '执行一批操作：执行前快照、逐条隔离错误、返回冻结回执与 diff。可带 planId 校验参数未被改动。单批上限 40。',
        params: { ops: 'array 操作数组', planId: 'string 可选，ops.plan 返回的 id' },
        run: a => opsApply(a),
    },
    {
        name: 'ops.journals',
        kind: 'read',
        desc: '查看本会话的操作批次日志：时间、条数、成功/失败、是否可回滚、是否已回滚。',
        params: { id: 'string 可选，指定批次 id 则返回该批详情' },
        run: a => opsJournals(a),
    },
    {
        name: 'ops.undo',
        kind: 'dangerous',
        desc: '按批次日志逆序回滚：世界书整本还原、角色字段还原、设置键还原。不可回滚的操作会被跳过并说明。',
        params: { id: 'string 批次 id（ops.journals 可查）' },
        run: a => opsUndo(a),
    },
];

export { OPS_LIMIT };
