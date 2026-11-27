import { c, participants, indexOfId, roleOf, msgVars, parseValue, stringifyValue, persistChat, refreshMessage, varStore, readVar, writeVar, deleteVar, describeMessage, getMessages, setMessage, createMessage, deleteMessages, swipeMessage } from './adv-lib-core.js';
import { entryFields, loadBook, getEntries, setEntry, deleteEntry, bindChatBook, POSITIONS, ROLES, setInject, clearInject, listInject } from './adv-lib-world.js';
import { allRegexes, buildRegExp, testRegex, setRegexEnabled, loadPreset, listPresets, setPersona, helper, helperInfo, listScripts, setScript, scriptMod, getScriptModule } from './adv-lib-ext.js';
import { branchChatAt, renameChatTo, attachedTriggers, triggerList, detachTrigger, attachTrigger, addTrigger, removeTrigger, listTriggers, personaAvatar, listPersonas, setPersonaDesc, switchPersona, listGroups, activateGroup, countTokens, expandMacros, genInfo, stopGen, setGlobalBook, qrApi, persistQuickReplies, qrSets, qrList, qrCreateSet, qrAdd, qrDelete, qrRun, searchAllChats, genRaw, SAMPLER_KEYS, samplerStore, samplerGet, samplerSet } from './adv-lib-aux.js';

export const ADV_TOOLS_B = [
    {
        name: 'regex.test', kind: 'read',
        desc: '拿真实正则对一段文本试跑，看替换结果（不动聊天）。',
        params: { id: '正则 id 或 scriptName', text: '待测文本' },
        run: a => testRegex(a),
    },
    {
        name: 'regex.setEnabled', kind: 'write',
        desc: '启用/停用某条正则（全局或角色正则都支持）。',
        params: { id: '正则 id 或 scriptName', enabled: 'true 启用 / false 停用' },
        run: a => setRegexEnabled(a),
    },
    {
        name: 'preset.list', kind: 'read',
        desc: '列预设名。api 默认 openai，文本补全用 textgeneration，指令模式用 instruct。',
        params: { api: 'openai|textgeneration|instruct|novel|kobold' },
        run: a => listPresets(a),
    },
    {
        name: 'preset.load', kind: 'write',
        desc: '加载某个预设（等同在 UI 里点选）。',
        params: { name: '预设名', api: '同上' },
        run: a => loadPreset(a),
    },
    {
        name: 'persona.set', kind: 'write',
        desc: '改用户人格描述（{user} 宏的内容）。',
        params: { text: '人格描述' },
        run: a => setPersona(a),
    },
    {
        name: 'script.list', kind: 'read',
        desc: '列出「酒馆助手」里的脚本/前端卡（需安装 JS-Slash-Runner 4.x）。',
        params: {},
        run: () => listScripts(),
    },
    {
        name: 'script.set', kind: 'write',
        desc: '在「酒馆助手」里新建/更新一个脚本（code 为完整 JS 源码，可实现任意酒馆改造）。',
        params: { name: '脚本名', code: 'JS 源码', enabled: '是否启用' },
        run: a => setScript(a),
    },
    /* ---------- v1.2 ---------- */
    {
        name: 'chat.branch', kind: 'write',
        desc: '从某楼开始分叉出一条新聊天（SSD 式叙事分支）。会切换当前聊天。',
        params: { id: '分叉起点楼层 id，-1=最后一楼' },
        run: a => branchChatAt(a),
    },
    {
        name: 'chat.rename', kind: 'write',
        desc: '重命名当前聊天文件。',
        params: { name: '新名字' },
        run: a => renameChatTo(a),
    },
    {
        name: 'event.on', kind: 'write',
        desc: '注册一个触发器：酒馆里发生某事件且内容命中关键词时，自动跑一个 Agent 任务（被动变主动）。task 里可用 {text} 占位命中内容。',
        params: { id: '可选 id', event: 'message_received / message_sent / character_message_rendered / generation_after_commands', match: '关键词或 /正则/', task: '要执行的任务' },
        run: a => addTrigger(a),
    },
    {
        name: 'event.off', kind: 'write',
        desc: '删除触发器。',
        params: { id: '触发器 id' },
        run: a => removeTrigger(a),
    },
    {
        name: 'event.list', kind: 'read',
        desc: '列出所有触发器及其挂载状态，并给出可用事件名。',
        params: {},
        run: () => listTriggers(),
    },
    {
        name: 'persona.list', kind: 'read',
        desc: '列出全部用户人格（名字/头像/描述/是否当前），以及当前 {user} 名。',
        params: {},
        run: () => listPersonas(),
    },
    {
        name: 'persona.desc', kind: 'write',
        desc: '写人格描述并可选设置插入位置/深度/角色（{user} 宏内容）。',
        params: { text: '描述文本', name: '人格名，缺省=当前', position: '0=系统提示 1=聊天内', depth: '插入深度', role: '0系统 1用户 2AI' },
        run: a => setPersonaDesc(a),
    },
    {
        name: 'persona.switch', kind: 'write',
        desc: '切换当前用户人格。',
        params: { name: '人格名' },
        run: a => switchPersona(a),
    },
    {
        name: 'group.list', kind: 'read',
        desc: '列出群聊及其成员数、聊天文件、当前是否在群聊。',
        params: {},
        run: () => listGroups(),
    },
];
