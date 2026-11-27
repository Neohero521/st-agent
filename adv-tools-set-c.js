import { c, participants, indexOfId, roleOf, msgVars, parseValue, stringifyValue, persistChat, refreshMessage, varStore, readVar, writeVar, deleteVar, describeMessage, getMessages, setMessage, createMessage, deleteMessages, swipeMessage } from './adv-lib-core.js';
import { entryFields, loadBook, getEntries, setEntry, deleteEntry, bindChatBook, POSITIONS, ROLES, setInject, clearInject, listInject } from './adv-lib-world.js';
import { allRegexes, buildRegExp, testRegex, setRegexEnabled, loadPreset, listPresets, setPersona, helper, helperInfo, listScripts, setScript, scriptMod, getScriptModule } from './adv-lib-ext.js';
import { branchChatAt, renameChatTo, attachedTriggers, triggerList, detachTrigger, attachTrigger, addTrigger, removeTrigger, listTriggers, personaAvatar, listPersonas, setPersonaDesc, switchPersona, listGroups, activateGroup, countTokens, expandMacros, genInfo, stopGen, setGlobalBook, qrApi, persistQuickReplies, qrSets, qrList, qrCreateSet, qrAdd, qrDelete, qrRun, searchAllChats, genRaw, SAMPLER_KEYS, samplerStore, samplerGet, samplerSet } from './adv-lib-aux.js';

export const ADV_TOOLS_C = [
    {
        name: 'group.activate', kind: 'write',
        desc: '切换到指定群聊。',
        params: { id: '群 id', name: '或群名' },
        run: a => activateGroup(a),
    },
    {
        name: 'token.count', kind: 'read',
        desc: '用酒馆自己的分词器算 token 数（和上下文预算口径一致）。',
        params: { text: '待算文本' },
        run: a => countTokens(a),
    },
    {
        name: 'macro.expand', kind: 'read',
        desc: '展开酒馆宏（{{user}}/{{char}}/{{getvar::x}}/{{time}} 等），用于验证变量与宏是否生效。',
        params: { text: '含宏的文本' },
        run: a => expandMacros(a),
    },
    {
        name: 'gen.info', kind: 'read',
        desc: '查看当前 API、模型名、上下文预算、当前聊天楼层数。',
        params: {},
        run: () => genInfo(),
    },
    {
        name: 'gen.stop', kind: 'write',
        desc: '中断正在进行的生成。',
        params: {},
        run: () => stopGen(),
    },
    {
        name: 'lb.setGlobal', kind: 'write',
        desc: '把某本世界书设为全局激活（等同 /world 命令）。',
        params: { name: '世界书名' },
        run: a => setGlobalBook(a),
    },
    /* ---------- v1.3 ---------- */
    {
        name: 'qr.sets', kind: 'read',
        desc: '列出「快速回复」的所有组、哪些挂成了全局/聊天、以及所有 automationId（酒馆原生自动化钩子）。',
        params: {},
        run: () => qrSets(),
    },
    {
        name: 'qr.list', kind: 'read',
        desc: '列出某个快速回复组里的按钮，含它执行的 message 和自动触发钩子。',
        params: { set: '组名' },
        run: a => qrList(a),
    },
    {
        name: 'qr.createSet', kind: 'write',
        desc: '新建一个快速回复组并可立即挂上（global 全局 / chat 当前聊天）。',
        params: { name: '组名', mount: 'global|chat|none' },
        run: a => qrCreateSet(a),
    },
    {
        name: 'qr.add', kind: 'write',
        desc: '往组里加一个按钮。message 是 STscript（如 /echo hi 或 /setvar key=x）。on.* 可让它在 AI 回复后/生成前自动执行，automation_id 可被 /automation 触发。',
        params: { set: '组名', label: '按钮名', message: 'STscript', icon: '图标', show_label: '显示文字', automation_id: '自动化 id', on: '{ai,user,startup,new_chat,before_generation…}' },
        run: a => qrAdd(a),
    },
    {
        name: 'qr.delete', kind: 'write',
        desc: '删除组里的某个按钮。',
        params: { set: '组名', label: '按钮名' },
        run: a => qrDelete(a),
    },
    {
        name: 'qr.run', kind: 'write',
        desc: '立即执行某个按钮（等于手点它），返回 STscript 管道结果。',
        params: { set: '组名', label: '按钮名', args: '传给 STscript 的参数对象' },
        run: a => qrRun(a),
    },
    {
        name: 'chat.searchAll', kind: 'read',
        desc: '在角色（或群聊）的所有聊天文件里做全文搜索，返回命中的聊天文件与楼层。比只搜当前聊天有用得多。',
        params: { query: '关键词', group: '群 id（可选）' },
        run: a => searchAllChats(a),
    },
    {
        name: 'gen.raw', kind: 'write',
        desc: '用酒馆当前 API 跑一次独立生成，结果不进聊天（相当于「问另一个模型一句话」，可指定 system 与长度）。',
        params: { prompt: '用户侧文本', system: '系统提示（可选）', length: '最大输出 token' },
        run: a => genRaw(a),
    },
    {
        name: 'sampler.get', kind: 'read',
        desc: '读当前采样参数（temperature / top_p / penalties / max_tokens 等）。',
        params: {},
        run: () => samplerGet(),
    },
    {
        name: 'sampler.set', kind: 'write',
        desc: '改采样参数（只改传入的字段，其余不动），写完立即存盘。',
        params: { values: '{temperature:0.8, top_p:0.9, …}' },
        run: a => samplerSet(a),
    },
];
