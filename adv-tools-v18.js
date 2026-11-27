/**
 * v1.8 工具层：酒馆的「安全网」与「磁盘管家」。
 *
 * 这一版来自对 src/endpoints 全部 46 个模块的逐文件核对，挑出三块 125 个工具里
 * 一个都没碰过的服务端能力：
 *
 *   1. settings 快照（/api/settings/get-snapshots|make-snapshot|load-snapshot|restore-snapshot）
 *      —— Agent 要批量改设置之前，先打一张快照，改坏了能退回。
 *   2. data-maid（/api/data-maid/report|delete）—— 真正扫磁盘，找孤立文件：
 *      没有卡认领的聊天、没人用的缩略图、旧备份。audit.run 只做统计，这个是能落地的清理。
 *   3. chats 备份（/api/backups/chat/get|delete）—— 酒馆自己给聊天打的 .jsonl 备份。
 *
 * 附带向量库（/api/vector/*）与统计（/api/stats/*）：前者是记忆检索的底层，
 * 后者是「我在哪个角色身上花的时间最多」。
 *
 * v1.11 模块化拆分：本文件只留工具壳，实现在 v18-lib / v18-snap / v18-maid / v18-vec。
 */
import { snapList, snapMake, snapLoad, snapRestore, backupChats, backupDelete } from './v18-snap.js';
import { maidReport, maidDelete } from './v18-maid.js';
import { vecList, vecQuery, vecInsert, vecPurge, statsGet, statsRecreate } from './v18-vec.js';

/* ------------------------------ 导出 ------------------------------ */

export const TOOLS = [
    {
        name: 'snap.list', kind: 'read',
        desc: '列 settings 快照：文件名、时间、体积、总量。快照存在 data/<user>/backups/，是整份 settings.json 的拷贝。',
        params: {},
        run: () => snapList(),
    },
    {
        name: 'snap.make', kind: 'write',
        desc: '立刻给当前 settings.json 打一张快照。批量改设置、装扩展、换主题之前先打一张，出事能退回。',
        params: {},
        run: () => snapMake(),
    },
    {
        name: 'snap.load', kind: 'read',
        desc: '读一张快照的结构（顶层键、字符数、是否含 characters/world_info/power_user），不返回全文。',
        params: { name: '快照文件名' },
        run: a => snapLoad(a),
    },
    {
        name: 'snap.restore', kind: 'dangerous',
        desc: '用快照整份覆盖当前 settings.json。不可撤销，必须 confirm: true；覆盖后要刷新页面才生效。',
        params: { name: '快照文件名', confirm: '必须 true' },
        run: a => snapRestore(a),
    },
    {
        name: 'backup.chats', kind: 'read',
        desc: '列酒馆自动打的聊天备份（backups/*.jsonl）：文件名、关联聊天、楼层数、最后一条。',
        params: { limit: '最多列几条，默认 20' },
        run: a => backupChats(a),
    },
    {
        name: 'backup.delete', kind: 'dangerous',
        desc: '删一个聊天备份文件。删之前先确认当前聊天本身没坏。',
        params: { name: '备份文件名（backup.chats 里的 file）' },
        run: a => backupDelete(a),
    },
    {
        name: 'maid.report', kind: 'read',
        desc: '扫磁盘找孤立文件（data-maid 报告）：没人认领的聊天、图片、附件、缩略图、旧备份、旧设置快照，按类给数量与体积，并返回本次专属 token。这是 audit.run 的落地版——它看的是真实磁盘。',
        params: { preview: '每类给几条样例，默认 5' },
        run: a => maidReport(a),
    },
    {
        name: 'maid.delete', kind: 'dangerous',
        desc: '按 maid.report 的 token + 具体 hash 删孤立文件（必须是报告里出现过的 hash，不能一把梭）。要 confirm: true。',
        params: { token: 'maid.report 返回的 token', hashes: '要删的 hash 数组', confirm: '必须 true' },
        run: a => maidDelete(a),
    },
    {
        name: 'vec.list', kind: 'read',
        desc: '看某个向量集合（通常一档聊天一个集合）已经索引了多少条：返回数量与前 20 个 hash。',
        params: { collectionId: '集合名，通常=聊天档名', source: '向量源，默认 transformers', model: 'embedding 模型（openai 等源需要）' },
        run: a => vecList(a),
    },
    {
        name: 'vec.query', kind: 'read',
        desc: '在向量集合里语义检索：给一段话，返回最像的楼层（index / hash / score / 前 160 字）。这是酒馆记忆检索的底层，能验证「记忆到底能不能被召回」。',
        params: { collectionId: '集合名', searchText: '查询文本', topK: '返回条数，默认 10', threshold: '相似度下限，0~1', source: '向量源', model: 'embedding 模型' },
        run: a => vecQuery(a),
    },
    {
        name: 'vec.insert', kind: 'write',
        desc: '往向量集合里写条目（{hash, text, index} 数组）。可用于手动补索引、或把外部笔记塞进记忆库。',
        params: { collectionId: '集合名', items: '数组', source: '向量源', model: 'embedding 模型' },
        run: a => vecInsert(a),
    },
    {
        name: 'vec.purge', kind: 'dangerous',
        desc: '清掉某个集合的索引（everything: true 则清整个向量源目录）。下次检索会自动重建，但重建要花时间。',
        params: { collectionId: '集合名', everything: 'true=全清', confirm: '全清时必须 true' },
        run: a => vecPurge(a),
    },
    {
        name: 'stats.get', kind: 'read',
        desc: '读酒馆统计（每个角色累计消息量等），按量排序取前 N。用来回答「我聊得最多的是谁」。',
        params: { top: '取前几名，默认 10' },
        run: a => statsGet(a),
    },
    {
        name: 'stats.recreate', kind: 'write',
        desc: '从磁盘上的聊天文件重建统计（会遍历全部聊天，慢，但能修掉数字对不上的情况）。',
        params: {},
        run: () => statsRecreate(),
    },
];
