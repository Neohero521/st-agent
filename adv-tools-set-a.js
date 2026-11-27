import { c, participants, indexOfId, roleOf, msgVars, parseValue, stringifyValue, persistChat, refreshMessage, varStore, readVar, writeVar, deleteVar, describeMessage, getMessages, setMessage, createMessage, deleteMessages, swipeMessage } from './adv-lib-core.js';
import { entryFields, loadBook, getEntries, setEntry, deleteEntry, bindChatBook, POSITIONS, ROLES, setInject, clearInject, listInject } from './adv-lib-world.js';
import { allRegexes, buildRegExp, testRegex, setRegexEnabled, loadPreset, listPresets, setPersona, helper, helperInfo, listScripts, setScript, scriptMod, getScriptModule } from './adv-lib-ext.js';
import { branchChatAt, renameChatTo, attachedTriggers, triggerList, detachTrigger, attachTrigger, addTrigger, removeTrigger, listTriggers, personaAvatar, listPersonas, setPersonaDesc, switchPersona, listGroups, activateGroup, countTokens, expandMacros, genInfo, stopGen, setGlobalBook, qrApi, persistQuickReplies, qrSets, qrList, qrCreateSet, qrAdd, qrDelete, qrRun, searchAllChats, genRaw, SAMPLER_KEYS, samplerStore, samplerGet, samplerSet } from './adv-lib-aux.js';

export const ADV_TOOLS_A = [
    {
        name: 'var.get', kind: 'read',
        desc: '读变量。scope=chat（聊天变量，MVU 主用）/ message（楼层变量）/ global（全局）/ character（角色卡）。message 作用域用 message_id 指定楼层（可 -1 表示最新）。',
        params: { scope: 'chat|message|global|character，默认 chat', key: '变量名，省略则返回全部', message_id: '楼层号，仅 message 作用域需要' },
        run: a => readVar(a.scope, a.key, a.message_id),
    },
    {
        name: 'var.set', kind: 'write',
        desc: '写变量（值会自动 JSON 字符串化，与酒馆 /setvar 行为一致）。对象/数组直接传 JSON。',
        params: { scope: '同上', key: '变量名（必填）', value: '新值', message_id: '楼层号' },
        run: a => writeVar(a.scope, a.key, a.value, a.message_id),
    },
    {
        name: 'var.delete', kind: 'write',
        desc: '删变量。',
        params: { scope: '同上', key: '变量名', message_id: '楼层号' },
        run: a => deleteVar(a.scope, a.key, a.message_id),
    },
    {
        name: 'msg.get', kind: 'read',
        desc: '读楼层消息（id/role/name/是否隐藏/swipe 数/变量名/正文前 1200 字）。不传范围则返回全部。',
        params: { from: '起始楼层（可负数）', to: '结束楼层', role: 'all|user|assistant|system', hide: 'all|hidden|visible' },
        run: a => getMessages(a),
    },
    {
        name: 'msg.set', kind: 'write',
        desc: '改某个楼层：正文（同步当前 swipe）、说话人、role（user/assistant/system）、是否隐藏。',
        params: { id: '楼层号（-1 = 最新）', text: '新正文', name: '说话人显示名', role: 'user|assistant|system', hidden: 'true 隐藏 / false 显示' },
        run: a => setMessage(a),
    },
    {
        name: 'msg.create', kind: 'write',
        desc: '插入一条楼层。role=system 会写成旁白（narrator）。',
        params: { role: 'user|assistant|system', text: '正文', name: '显示名', hidden: '是否隐藏', at: '插入位置（楼层号，默认末尾）' },
        run: a => createMessage(a),
    },
    {
        name: 'msg.delete', kind: 'dangerous',
        desc: '删除楼层。给 ids 数组按多楼，或用 id + count 连续删。',
        params: { id: '起始楼层', ids: '楼层数组', count: '连续删除数量，默认 1' },
        run: a => deleteMessages(a),
    },
    {
        name: 'msg.swipe', kind: 'write',
        desc: '切换某楼的 swipe（多回复版本）。dir=left/right，或用 index 直接跳。',
        params: { id: '楼层号', dir: 'left|right', index: '目标 swipe 序号' },
        run: a => swipeMessage(a),
    },
    {
        name: 'lb.getEntries', kind: 'read',
        desc: '读世界书条目（含 keys/content/order/position/depth/probability/constant/enabled）。可用 keyword 模糊搜。',
        params: { name: '世界书名', uid: '只看某条', keyword: '关键词', limit: '返回条数上限，默认 50' },
        run: a => getEntries(a),
    },
    {
        name: 'lb.setEntry', kind: 'write',
        desc: '写世界书条目：有 uid 就改，没有就新建（自动分配 uid）。只传要改的字段。',
        params: { name: '世界书名', uid: '条目 uid', keys: '主关键词（数组或逗号分隔）', secondary_keys: '次关键词', content: '内容', comment: '备注/标题', order: '插入顺序', position: '0 前置/1 后置/…', depth: '深度', probability: '触发概率', constant: '常驻', enabled: '启用' },
        run: a => setEntry(a),
    },
    {
        name: 'lb.deleteEntry', kind: 'dangerous',
        desc: '删除世界书某条目。',
        params: { name: '世界书名', uid: '条目 uid' },
        run: a => deleteEntry(a),
    },
    {
        name: 'lb.bindChat', kind: 'write',
        desc: '把世界书设为当前聊天的挂载世界书（chat lorebook）。',
        params: { name: '世界书名' },
        run: a => bindChatBook(a),
    },
    {
        name: 'inject.set', kind: 'write',
        desc: '往提示词里注入一段常驻文本（扩展注入位）。position=in_chat 时按 depth 插进对话。',
        params: { key: '注入槽位名，默认 st-agent', text: '文本', position: 'in_prompt|in_chat|before_prompt', depth: 'in_chat 时的深度', role: 'system|user|assistant', scan: '是否允许世界书扫描' },
        run: a => setInject(a),
    },
    {
        name: 'inject.clear', kind: 'write',
        desc: '清掉某个注入槽位。',
        params: { key: '槽位名' },
        run: a => clearInject(a),
    },
    {
        name: 'inject.list', kind: 'read',
        desc: '列出当前所有提示词注入（含酒馆自带的 note/depth prompt）。',
        params: {},
        run: () => listInject(),
    },
];
