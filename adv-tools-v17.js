/**
 * v1.7 工具层：群聊的完整 CRUD、角色卡内嵌世界书的抽取，以及一次性的「酒馆体检」。
 *
 * 这三块是前面六版一直没碰的空白：
 *   - 群聊只有 v1.2 的 list / activate，建群、改成员、删群都得回 UI 手点
 *   - 角色卡里的 character_book（内嵌世界书）以前只能整卡导出再手工拆
 *   - 没见过有人能一句话回答「我的酒馆是哪里在变胖」
 *
 * v1.11 模块化拆分：本文件只留工具壳，实现在 v17-lib / v17-group / v17-book / v17-audit。
 */
import { groupAll, groupInfo, groupCreate, groupEdit, groupDelete } from './v17-group.js';
import { charBook, charBookExtract } from './v17-book.js';
import { auditRun, extMaintain } from './v17-audit.js';

/* ------------------------------ 导出 ------------------------------ */

export const TOOLS = [
    {
        name: 'group.all', kind: 'read',
        desc: '列全部群聊：id、名字、成员数、禁用成员数、激活策略、聊天档数与体积、最后聊天时间。比 group.list 多给体积和时间，用来判断哪个群该清。',
        params: {},
        run: () => groupAll(),
    },
    {
        name: 'group.info', kind: 'read',
        desc: '看一个群聊的成员明细（头像、角色名、是否被禁用）与生成设置。传 id 或群名。',
        params: { group: '群聊 id 或名字' },
        run: a => groupInfo(a),
    },
    {
        name: 'group.create', kind: 'write',
        desc: '新建群聊。members 传角色头像文件名数组（不是显示名），激活策略 0=自然顺序 1=列表顺序 2=随机。',
        params: { name: '群名', members: '头像数组', activation_strategy: '0|1|2，默认 0', allow_self_responses: '是否允许自己接话', generation_mode: '默认 0', auto_mode_delay: '自动模式间隔秒，默认 5' },
        run: a => groupCreate(a),
    },
    {
        name: 'group.edit', kind: 'write',
        desc: '改群聊：改名、整体替换成员、加成员（add）、踢成员（remove）、改激活策略 / 是否允许自答 / 生成模式。只传要改的。',
        params: { group: 'id 或名字', name: '新群名', members: '整体替换的头像数组', add: '要加的头像（单个或数组）', remove: '要踢的头像', activation_strategy: '0|1|2', allow_self_responses: '布尔', generation_mode: '数字' },
        run: a => groupEdit(a),
    },
    {
        name: 'group.delete', kind: 'dangerous',
        desc: '删群聊，连它名下的 groupChats/*.jsonl 一起删。不可恢复。',
        params: { group: 'id 或名字' },
        run: a => groupDelete(a),
    },
    {
        name: 'char.book', kind: 'read',
        desc: '读角色卡内嵌世界书（data.character_book）：条目数、书名叫什么、前几条的 comment/keys/是否启用，以及这张卡当前绑的独立世界书。',
        params: { avatar: '头像文件名（不传=当前角色）', limit: '预览条数，默认 5' },
        run: a => charBook(a),
    },
    {
        name: 'char.bookExtract', kind: 'write',
        desc: '把角色卡内嵌世界书抽成一个独立世界书（用酒馆自己的 convertCharacterBook 转字段，不改原卡）。原名存在时默认拒绝，overwrite 才覆盖。',
        params: { avatar: '头像（不传=当前角色）', world_name: '新世界书名，默认 book.name 或「角色名 - 内嵌书」', overwrite: '同名时是否覆盖' },
        run: a => charBookExtract(a),
    },
    {
        name: 'audit.run', kind: 'read',
        desc: '一次导出酒馆体检报告：角色卡×聊天档数量与楼层、世界书条目量（含没写 key 的死条目）、群聊体积、最近聊天里最大的一档、正则条数，并给出可执行的清理建议。想回答「我的酒馆哪里在变胖」用这个。',
        params: { chatSample: '最多采样多少档最近聊天，默认 200' },
        run: a => auditRun(a),
    },
    {
        name: 'ext.maintain', kind: 'write',
        desc: '维护第三方扩展（需酒馆助手在线）：update 拉最新版、reinstall 原地重装。用于升级酒馆助手自己这类扩展。',
        params: { action: 'update|reinstall', id: '扩展目录名，如 JS-Slash-Runner' },
        run: a => extMaintain(a),
    },
];
