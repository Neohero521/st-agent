# ST Agent · 酒馆内部的自主 Agent

装进 SillyTavern 扩展目录就能用：在酒馆里开一个 Agent 面板，模型自己规划、自己调工具、多轮执行到任务完成。改角色卡、改世界书、翻聊天记录、调设置、加正则、跑 STscript——全走酒馆自己的接口，不需要动服务端，不需要改 `config.yaml`。

## 安装（30 秒）

**方式一：用酒馆自带的「从 URL 安装扩展」（推荐）**

扩展 → 安装扩展 → 粘贴仓库地址：

```
https://github.com/Neohero521/st-agent
```

仓库根目录就是扩展本体（`manifest.json` / `index.js` / `tools.js` / `adv-tools.js` / `adv-tools-v14.js` … `adv-tools-v19.js` / `style.css` 全在根上），酒馆克隆后直接识别，不需要手动挑子目录。装完刷新页面，右下角出现「Agent」悬浮球。

**方式二：手动复制文件**

把仓库根目录的**全部 `.js` 与 `.css`**（`manifest.json`、`index.js`、`tools.js`、`adv-tools.js`、`adv-tools-v14.js`…`adv-tools-v19.js`、`style.css`）放进

```
<酒馆根目录>/data/<你的用户名>/extensions/st-agent/
```

没有目录就自己建。`tools.js` / `adv-tools.js` 必须一起放（被 `index.js` import）；`adv-tools-v*.js` 是**按文件名动态 import** 的，缺哪个就少哪一层工具（v14 深改、v15 自动化链、v16 酒馆助手、v17 群聊体检、v18 安全网与磁盘、v19 连接层），不会报错但会静默少功能——所以别只拷前五个文件，整目录一起拷。刷新页面即可。

**方式三：一条命令（本目录 / zip 版）**

```bash
bash install.sh /path/to/SillyTavern          # Linux / macOS / Termux
```

```powershell
.\install.ps1 -StDir "C:\SillyTavern"          # Windows
```

装完直接下指令就行：面板**默认走你酒馆「API 连接」里配好的当前 API**（模型、密钥、代理都用现成的），不需要另外建连接配置。面板设置里的「模型来源」也支持选连接管理器里的某个 profile（想要独立模型/独立额度时用）。

**怎么打开面板**：电脑端点右下角「Agent」悬浮球；手机 / 平板点输入框上方的魔杖菜单 → ST Agent（手机端悬浮球按设计隐藏，避免压住酒馆输入框）。

## 它能做什么

**角色卡**：`char.list` `char.get` `char.create` `char.edit` `char.rename` `char.delete`
新建、改字段（描述/性格/场景/开场白/示例对话/tags/系统提示）、改名、删除（可连带删聊天记录）。

**世界书**：`world.list` `world.get` `world.create` `world.save` `world.delete` `world.upsertEntry` `world.deleteEntry`
按 key 精确增改条目，不比手点 UI 差。

**聊天记录**：`chat.list` `chat.get` `chat.search` `chat.readCurrent` `chat.append` `chat.editMessage` `chat.deleteMessage` `chat.delete`
搜索历史、往当前会话插消息、改错字、删楼、删档。

**设置与扩展**：`setting.get` `setting.set` `preset.save` `preset.delete` `extension.list` `extension.install` `extension.delete` `regex.list` `regex.upsert` `ui.reload`

**兜底**：`st.command` 直接执行任意 STscript（`/go` `/sys` `/world` `/trigger` …），等于拿到酒馆全部指令；`st.state` 读当前模型、上下文、角色、世界书等运行态。

全部改动走酒馆自己的 `/api/*`，所以**酒馆内存缓存是同步的**——改完立刻生效，不用重启。

## 进阶能力（v1.1）

工具数 33 → 55。新的一层直接调酒馆内部的 `getContext()`（`chatMetadata` / `setExtensionPrompt` / `loadWorldInfo` / `variables.*` / `getPresetManager` / `swipe`），比走 HTTP 更直接，写完即同步缓存。

**变量（MVU 场景核心）**：`var.get` `var.set` `var.delete`
作用域 `chat`（聊天变量，MVU 主用）/ `message`（楼层变量，自动落到 `chat[i].variables[swipe_id]`）/ `global` / `character`。值按酒馆规则 JSON 字符串化，和 `/setvar` 完全一致，所以 MVU、提示词模板都能直接读到。

**楼层消息**：`msg.get` `msg.set` `msg.create` `msg.delete` `msg.swipe`
按楼层读写，支持 role 改写（`system` 写成旁白）、隐藏/显示（`is_system`）、多 swipe 切换、插入位置指定。

**世界书条目**：`lb.getEntries` `lb.setEntry` `lb.deleteEntry` `lb.bindChat`
条目级增改（只传要改的字段，新条目自动补全酒馆要求的默认字段），并且走 `loadWorldInfo` / `saveWorldInfo`，编辑器缓存同步。

**提示词注入**：`inject.set` `inject.clear` `inject.list`
把一段常驻文本插进提示词（`in_prompt` / `in_chat` + depth / `before_prompt`，可选 role 与是否允许世界书扫描）。等于让 Agent 给你加“临时世界书”。

**正则**：`regex.test` `regex.setEnabled`
拿真实正则对任意文本试跑看替换结果，错了不会弄脏聊天；也能一键启停全局/角色正则。

**预设与人格**：`preset.list` `preset.load` `persona.set`

**和「酒馆助手」(JS-Slash-Runner) 协同**：`script.list` `script.set`
检测到酒馆助手 4.x 时，可以直接列/建/改它的脚本树（`code` 传完整 JS）。这是“按意愿改造酒馆 UI 与行为”的通道；没装也不影响其它工具。

## 自主性（v1.2）

工具数 55 → 70。这一版的关键是让 Agent **不只在被点开时才工作**，而是能挂到酒馆的事件上自己动起来。

**事件触发器（被动 → 主动）**：`event.on` `event.off` `event.list`

```
event.on {
  event: "message_received",
  match: "/决斗|战斗/",
  task:  "每出现战斗描写，就检查当前角色卡有没有战斗属性，没有就补上"
}
```

`match` 支持纯文本包含或 `/正则/` 写法；`task` 里可以用 `{text}` 引用命中内容。挂上之后，酒馆每收到一条消息，Agent 自己判断是否命中并跑一轮任务。触发器存在 `extension_settings['st-agent-triggers']`，刷新页面会自动重新挂载，`event.list` 的 `attached` 字段告诉你是否真的挂上了。可用事件就是酒馆自己的 `eventTypes`（`message_sent` / `message_received` / `character_message_rendered` / `generation_after_commands` / `chat_changed` / `group_chat_created` 等一百多种）。

> 触发器会消耗 API 额度，`match` 建议写窄一点，别用空字符串挂 `message_received`。

**叙事分支**：`chat.branch` `chat.rename`
`chat.branch` 调用酒馆内部的 `branchChat(mesId)`，从某楼分叉出新聊天并自动切过去——和你手点「分叉」是同一个实现。`{ id: -1 }` 表示从最后一楼分叉。

**人格**：`persona.list` `persona.desc` `persona.switch`
列出人格（当前 `{user}` 是谁）、写描述并可设 `position` / `depth` / `role`（等于 UI 里的高级人格设置）、换人设。

**群聊**：`group.list` `group.activate`
列群聊与成员数，直接切进某个群聊，之后所有工具都作用于该群聊。

**其它**：`token.count`（酒馆自己的分词器，和上下文预算同口径）、`macro.expand`（展开 `{{user}}` / `{{getvar::}}` / `{{time}}`，验证变量与宏是否真的生效）、`gen.info` / `gen.stop`、`lb.setGlobal`（`/world` 同款）。

## 自动化与检索（v1.3）

工具数 70 → 80。这一层把酒馆的「快速回复」变成了 Agent 的按钮工厂。

**快速回复 = 给酒馆装按钮**：`qr.sets` `qr.list` `qr.createSet` `qr.add` `qr.delete` `qr.run`

```
qr.createSet { name: "剧情辅助", mount: "global" }
qr.add {
  set: "剧情辅助", label: "回看主线",
  message: "/summarize 主线",
  on: { ai: true }        // AI 每次回复后自动执行
}
```

`qr.add` 支持 `icon` / `show_label` / `automation_id`，以及 `on` 里的一整套原生钩子：`startup` / `user` / `ai` / `chat_change` / `new_chat` / `before_generation`。这些钩子由酒馆的快速回复引擎调度，比外部事件监听更贴近原生行为。`qr.run` 可以立即执行某个按钮并拿到 STscript 的管道结果。写操作会自动存盘，刷新页面按钮还在（实测过）。

**跨库全文检索**：`chat.searchAll`
走 `/api/chats/search`，在角色（或群聊）的**所有**聊天文件里搜关键词，返回命中的文件与楼层——找哪一档聊天里提过某个设定，终于不用一个个点开。

**独立生成**：`gen.raw`
用酒馆当前 API 跑一次不进聊天的生成（可带 system 与长度）。适合让 Agent 悄悄向模型问一句话、做二次判断，不污染对话。

**采样器**：`sampler.get` `sampler.set`
读写 `temperature` / `top_p` / `top_k` / penalties / `max_tokens`，写完立即存盘。

## 角色卡深改与资产（v1.4）

工具数 80 → 93。这一层解决的是酒馆 UI 里最费手的几件事。

**角色卡深度合并（重点）**：`char.merge` `char.bulkMerge`

走 `/api/characters/merge-attributes`——**深度合并 + V2 校验 + `__@@UNSET@@__` 哨兵删字段**。所以它能写 `edit-attribute` 写不进去的字段，尤其是 `data.extensions.world`（角色卡绑定世界书）、`depth_prompt`，以及任意自定义 extensions 键。

```
char.merge { avatar: "Seraphina.png", fields: { data: { extensions: { world: "Eldoria" } } } }
char.merge { avatar: "Seraphina.png", unset: ["data.extensions.world"] }   // 删字段
char.bulkMerge { avatars: [], fields: { data: { extensions: { talkativeness: "0.5" } } } }
```

`char.bulkMerge` 的 `avatars` 传空数组 = 作用于目录下**全部**角色卡，还能用 `filterPath` 先筛（例如只改已经绑过世界书的卡）。批量补字段这是唯一正路，逐张走 `edit-attribute` 会慢到不可用。

**角色卡导出与复制**：`char.exportJson` `char.duplicate`

`char.exportJson` 拿回 V2 JSON（含内嵌 `character_book` 条数与 extensions 键名清单），核对内嵌世界书、检查绑定关系都靠它。

**任意聊天文件直读**：`char.chats` `chat.readFile`

`char.chats` 列某张卡下所有聊天档（楼层数 + 最后一条预览）；`chat.readFile` 走 `/api/chats/export` 的 jsonl 短路径，把**任意一档**聊天读成楼层数组——不用先切过去、也不用打开它。Agent 第一次能遍历磁盘上的所有聊天档。

**聊天生命周期**：`chat.new` `chat.close`

**背景与主题**：`bg.list` `bg.set` `bg.delete` `theme.list`

`bg.set` 支持部分名匹配（写 `bedroom red` 就命中 `bedroom red.jpg`）。

**触发器预演**：`event.test`

挂 `event.on` 之前先拿一段模拟消息跑一遍，看哪些触发器会命中、会跑什么任务。`match` 写错导致每楼都触发、白烧额度的事，用这个先拦住。

**架构改动（值得知道）**：`tools.js` 末尾加了**探针式加载器**——新工具模块按 `adv-tools-vN` 命名丢进扩展目录就会自动挂进 `ADV_TOOLS`，不必再改 `tools.js` / `adv-tools.js` / `index.js`。v1.4 的 13 个工具都在 `adv-tools-v14.js` 里，是这个机制的第一次使用；以后每版只需新增一个小文件。

## 世界书驱动的自动化（v1.5）

工具数 93 → 104。这一层把酒馆自己的自动化引擎接了出来：**世界书条目命中 → 按 automationId 找按钮 → 执行 STscript**。

**先讲清机制**（`public/scripts/extensions/quick-reply/src/AutoExecuteHandler.js`）

`handleWIActivation(entries)` 拿到本次被激活的世界书条目，取它们的 `automationId`，再去**已挂载**的 QR 组里找 `automationId` 相同的按钮并逐个执行。有两条容易踩的隐性规则：

- 按钮所在组必须在 global / chat / character 三层配置里**已挂载**，否则写了 id 也永远不会触发（这就是 `dormant_buttons`）
- 世界书条目的字段是 `entry.automationId`（UI 里显示成 `automation_id`），必须写在条目上，不是写在 `extensions` 里

**配对诊断**：`automation.list` `automation.run` `lb.setAutomation`

`automation.list` 把「按钮的 id」和「世界书条目的 id」拉到同一张表对照，直接告诉你哪边没配上：

```
automation.list {}
→ automation_ids: 1, active_buttons: 0, entries: 1
   dormant_buttons: [{ set: "AutoChain", label: "auto-echo", scope: "unmounted" }]
   unmatched_ids: ["v15test"]        ← 有一边没配对
```

`lb.setAutomation` 给条目写 id（传空串即清除）；`automation.run` 立即按 id 触发一次，等于模拟世界书命中，返回每个按钮的 STscript 管道结果——不用真等世界书触发就能验证整条链。

实测过的完整闭环（并在测试环境清理干净）：建组 → 加按钮（`automation_id: "v15test"`, `message: "/echo ..."`）→ 给 Eldoria 条目写 id → 未挂载时 `automation.run` 报「有 1 个同 id 按钮但未挂载（AutoChain/auto-echo），先用 qr.mount 挂上」→ 挂上后 `automation.run` 返回 `"v15-updated"`。

**QR 组与按钮的完整管理**：`qr.update` `qr.mount` `qr.deleteSet` `qr.export` `qr.context`

- `qr.update` 原位改按钮（message / 图标 / 标题 / 显隐 / automation_id / 七个钩子），不用删了重建
- `qr.mount` 挂到全局或当前聊天、`target: "none"` 全卸、`visible: false` 只挂不显示（仍能被 automationId 命中）
- `qr.context` 把另一个组挂成按钮的右键子菜单（`createContextItem`）
- `qr.export` 导出整组结构化 JSON，方便备份 / 迁移到别的机器

**修掉的两个真实坑**

- `toggleGlobalSet / toggleChatSet` 的语义是「**有则删、无则加**」，不是"确保可见"。第一版拿它当开关，结果把本来挂着的组卸掉了，`after.global` 从 true 变 false —— 现在统一走「先移除（若已挂）再按指定可见性添加」
- `qr.contextList` 不是 `contextLinks`，字段名写错会导致读数永远是空数组

**跨角色检索与生成**：`chat.recent` `msg.trigger` `msg.continue`

`chat.recent` 走 `/api/chats/recent`，一次列出所有角色（含群聊）最近改动的聊天档并带楼层数与最后一条预览——找「最近玩过哪几档」不用先选角色。`msg.trigger` / `msg.continue` 是对 `/trigger` 与 `/continue` 的封装（会消耗额度）。

## 酒馆助手直连层（v1.6）

工具数 104 → 116。装了「酒馆助手」(JS-Slash-Runner 4.x) 之后多出 12 个工具，补上原生扩展够不到的三块：**预设提示词的逐条改写**、**世界书绑定关系**、**楼层重排与渲染态文本**。

`th.status` `preset.prompts` `preset.promptEdit` `preset.promptAdd` `preset.promptRemove` `preset.promptOrder` `lore.bind` `lore.settings` `msg.rotate` `msg.render` `import.raw` `gen.models`

一句话说明价值：酒馆的 `PromptManager`、`rotateChatMessages`、世界书的 `charLore` / `chat_metadata` 绑定，全都不在 `getContext()` 里；酒馆助手把它们包了出来，这一层再把它们交到 Agent 手上。没有酒馆助手时这 12 个工具保留在列表里但会明确报错，其余 104 个照常工作。

装酒馆助手有两个硬坑（本轮实测踩出来的，写在 `docs/v1.6-tavern-helper.md`）：必须放 `extensions/` 的直接子目录（不是 `third-party/`），且 `lib/` 目录不能漏——漏了会 `Failed to fetch dynamically imported module`，控制台只有一串 404，`TavernHelper` 永远是 `undefined`。

## 群聊、内嵌书与体检（v1.7）

工具数 116 → 125。前面六版把单卡单聊几乎挖穿了，剩下的空白其实是**群聊**、**角色卡里塞着的那本世界书**，还有**「我这个酒馆到底哪里在变胖」**。

`group.all` `group.info` `group.create` `group.edit` `group.delete` `char.book` `char.bookExtract` `audit.run` `ext.maintain`

- **群聊整组管理**：`group.create` 一句话建群（传角色头像名，自动校验头像存不存在），`group.edit` 改名 / 整体换成员 / `add` 加人 / `remove` 踢人 / 改激活策略 / 允许自答，`group.delete` 连它名下的 `groupChats/*.jsonl` 一起删。此前 v1.2 只有 `group.list` 和 `group.activate`，建群改人还得回 UI 手点。
- **内嵌世界书**：`char.book` 读卡里 `data.character_book` 有几条、书叫啥、前几条的 keys；`char.bookExtract` 用**酒馆自己的** `convertCharacterBook` 把它抽成独立世界书（不手搓字段，`position`/`depth`/`enabled` 这些是反的，自己映射必错），且不动原卡。
- **酒馆体检**：`audit.run` 一次给出角色卡×聊天档数量与楼层、每本世界书条目量（含没写 key 的**死条目**、全禁用条目、重复键）、群聊体积、最近聊天里最大的一档、正则条数，并把它们翻译成可执行的建议（比如「这 3 张卡从没聊过，想清磁盘从它们下手」）。
- **扩展自维护**：`ext.maintain {action:'update'|'reinstall', id}`。

**这一版修掉的两个真实坑**（实测记录见 `docs/v1.7-groups-audit.md`）

- `getContext()` 里**没有** `createNewWorldInfo`。建世界书只能 `saveWorldInfo(name, {entries:{}}, true)` 先落空本占位再写内容，直接调用前端创建函数会 `is not a function`。
- `ext.maintain` 必须先探 `remote_url`：`/api/extensions/update` 只会 `git pull`，手动拷贝进目录的扩展必然 500；而 `reinstallExtension` 的逻辑是「先 `delete` 再按 `remote_url` 装回」——非 git 扩展的 `remote_url` 是空，等于**删掉就装不回来**。所以非 git 环境下 reinstall 被工具直接拒绝，只回结构化原因。

## 安全网与磁盘管家（v1.8）

工具数 125 → 139。这一版不是凭感觉加的：把 `src/endpoints/` **46 个模块**的路由全列出来，跟已有 125 个工具做差集，剩下的空白恰好是 Agent 最缺的两样东西——**能退回，和能清理**。

`snap.list` `snap.make` `snap.load` `snap.restore` `backup.chats` `backup.delete` `maid.report` `maid.delete` `vec.list` `vec.query` `vec.insert` `vec.purge` `stats.get` `stats.recreate`

- **设置快照**：`snap.make` 一条命令给当前 `settings.json` 打快照（实测 9 → 10 张，每张 45 KB），`snap.restore` 整份覆盖回去（要 `confirm: true`，且必须刷新页面）。批量改设置、装扩展、换主题之前先打一张——这是唯一能整套救回来的路。`snap.load` 只回结构不回全文（settings.json 常有几 MB）。
- **data-maid 磁盘清理**：`maid.report` 真扫磁盘，列九类孤立文件（没人认领的聊天 / 图片 / 附件 / 缩略图 / 旧聊天备份 / 旧设置快照）；`maid.delete` 拿报告里的 `token` + 具体 `hash` 删，服务端会再 `isPathUnderParent` 校验一次归属。**工具层故意不支持"全删"**，模型没法手滑清空磁盘。
- **聊天备份**：`backup.chats` 列酒馆自动打的 `backups/*.jsonl`（体积、楼层数、最后一条文本），`backup.delete` 删单个。
- **向量库**：`vec.list` / `vec.query` / `vec.insert` / `vec.purge` —— 酒馆记忆检索的底层。`vec.list` 是零风险探针（只读 hash 表，不触发 embedding），先看这档有没有索引，再决定要不要 `query`。
- **统计**：`stats.get` 按消息量排序（`stats.recreate` 从磁盘聊天文件重建）。

**实测数据**：`maid.report` 在一个"很干净"的测试环境里仍有 `total 14 / 428 KB` —— 全是酒馆自己攒的 settings 快照与 chat 备份，这些从来不会自动清。所以「磁盘怎么越来越大」这个问题的答案，多半就在这里。

**这一版踩的两个坑**：`getChatInfo` 的字段不是 `mes_count`，是 `chat_items`（楼层）+ `mes`（最后一条正文）+ `last_mes`（mtime 毫秒数）+ `file_size`（格式化字符串如 `400B`）；`/api/stats/get` 会把 `timestamp` 混进角色表（值是数字），必须按「value 是对象」过滤，否则统计里会多出一个叫 timestamp 的"角色"。

**没做的**：世界书改名（JSR 的 `renameWorldbook` 在源码里是**注释掉的**，`worldbook.ts:416`；原生 `/api/worldinfo/*` 也没有 rename，硬做会丢绑定）；`backup.chat/download` 是 `response.download` 浏览器下载，前端 fetch 拿不到内容；`secrets/*` 需要 `config.yaml` 的 `allowKeysExposure: true`，默认关闭，整块跳过。

## 连接层、图库与资产搬运（v1.9）

工具数 139 → 154。前面八版有个共同的空缺：Agent 能改角色卡、世界书、聊天、设置，却**不知道自己现在接的是哪个模型、这个 key 到底配没配、这个端点能生成什么**。这一版补的是「自我认知」和「资产搬运」。

`api.state` `api.models` `api.key` `api.secrets` `api.switch` `img.index` `img.folders` `img.folderCreate` `img.assign` `img.cleanup` `file.upload` `file.delete` `preset.restore` `theme.save` `translate.run`

- **连接层**：`api.state` 一句话说清「main_api 是啥、聊天补全源是哪家、模型名、端点、上下文与 token 上限、当前预设、哪些密钥配过」；`api.models` 拉当前 source 的模型清单——它同时就是一次**真实连通性测试**（能列出来说明 key 与端点都好用）；`api.key` 写/换密钥（服务端加密落盘，不回显）；`api.secrets` 只列脱敏值；`api.switch` 切 source/模型立即生效（改 `oai_settings` + `saveSettingsDebounced`），切 `main_api` 会写盘但提示 `needs_reload`。
- **图库**：酒馆 1.13+ 的图片元数据索引（独立于真实文件系统）。`img.index` 看总图数/文件夹/打标数量，`img.folderCreate` 建分类，`img.assign` 批量归类或移出，`img.cleanup` 清「文件早就不在了」的孤立条目（不动真实图片）。
- **资产搬运**：`file.upload` 把 base64 写成酒馆文件区文件并返回可引用路径；`file.delete` 删（需 confirm）；`preset.restore` 取出厂预设原样内容（只读，要真恢复得整份喂 `preset.save`）；`theme.save` 把整套主题变量落盘；`translate.run` 用酒馆内置翻译翻一段文本，不烧聊天额度。

**密钥安全边界**：只用 `/api/secrets/read`（服务端已脱敏成 `sk-abc…`）。`secrets/view` 要 `config.yaml` 的 `allowKeysExposure: true`（默认 false）——所以**任何工具都不会把明文密钥交给模型**。

**这一版踩的坑**：`/api/files/upload` 返回的是 `/user/files/…`（单数 `user`，不是 `users`）；`/api/translate/google` 在受限网络下直接 500，换 `bing` 立刻可用；`/api/presets/restore` 名字像「恢复」其实只返回内容不落盘；`/api/image-metadata/cleanup` 没有预演模式（所以第一版那个 `dryRun` 参数是假参数，已删）；`api.state` 第一版把 `getChatCompletionModel()` 直接叫 `model`，但 `main_api` 不是 openai 时它返回的是「聊天补全页里存的模型」而非实际在用的，已改名 `chat_completion_model` 并写清适用条件。

## 可选增强：磁盘桥接

上面这些已经覆盖「酒馆内部文件」的全部 CRUD。如果你还想要**任意路径读写、grep 整个装包、跑 shell 命令**，再装 `st-agent-bridge`（服务端插件）：

1. 把 `st-agent-bridge` 放进 `<酒馆根目录>/plugins/`
2. `config.yaml` 里设 `enableServerPlugins: true`
3. 重启酒馆

面板会自动检测到它在线，多出 9 个工具：`fs.info` `fs.list` `fs.read` `fs.write` `fs.edit` `fs.copy` `fs.glob` `fs.grep` `exec`。不装也完全不影响主功能。

桥接侧的安全设计：路径白名单（酒馆根 + `data/`，可用 `config.json` 的 `extraRoots` 追加）；写前自动备份到 `data/_agent/backups/<时间戳>/`；全量审计 `data/_agent/audit.jsonl`；`allowExec` / `allowDelete` 可单独关。

## 怎么用

- 直接说人话：「把 Eldoria 里所有 constant 条目按 insertion_order 重排」「找出提到旧角色名的聊天，列出来」「给所有角色卡绑同一个世界书」「把某一档不打开的聊天按楼层列出来」
- 面板按 `你 → 计划 → 工具调用（可展开看原始结果）→ 结论` 流式展示
- 审批三档：仅高危 / 写操作 / 每步确认（设置里切）
- 步数上限默认 20，随时「停止」

## 常见问题

**从 URL 安装报 500**
酒馆的安装接口只读“克隆目录根”的 `manifest.json`，根上没有就一律 500。如今仓库根已经有了；如果仍报 500，看酒馆服务端日志，基本是主机没装 `git` 或到 GitHub 的网络不通（此时改用手动复制）。

**找不到入口 / 悬浮球没出现**
手机上本来就不显示悬浮球，走魔杖菜单。电脑端没有球，先确认路径：必须是 `data/<用户名>/extensions/st-agent/`，且目录里直接能看到 `manifest.json` 与 `index.js`（不是再多一层 st-agent/）。放对后 F12 控制台应能看到 `STAgent`。

**面板报「酒馆当前 API 调用失败」**
说明已经直连到酒馆当前 API，只是这个 API 回了业务错误。检查「API 连接」页：模型名是否存在、密钥是否有效、代理地址是否可达。常见如 `No Horde model available` = Kobold Horde 没可用模型；`401` = 密钥失效。
如果你想让面板用**另一套**模型（不动酒馆主 API），在「连接管理器」建 profile，再回面板「模型来源」里选它。

**回复不是逐字流式**
默认直连模式走酒馆的 raw 生成，等整段返回后一次显示（面板顶部会提示「生成中」）。需要逐字流式就选连接管理器 profile。

**工具报 403 / CSRF**
酒馆开了 CSRF 保护时，扩展用的是酒馆自己的请求封装，正常不会触发；如果你手动改过 `request.js` 或用了反向代理改写，需要放行。

**想确认装了几个工具**
F12 执行 `STAgent.tools.length`：基础 154（进阶/自主/自动化/深改/自动化链/酒馆助手/群聊体检/安全网/连接层九层），装桥接是 163。

## 开发

```js
STAgent.tools                              // 当前可用工具（随桥接状态变化）
STAgent.executeTool({name:'var.get', args:{scope:'chat'}})
STAgent.mockGenerate(fn)                   // 用自定义函数代替模型，离线调试循环
STAgent.run('列出所有世界书')
```

加工具三种方式：

1. **新开一个 `adv-tools-vN.js`，导出 `TOOLS` 数组**（推荐，不用改任何现有文件；v14 / v15 / v16 … v19 都已被探针预置）
2. `adv-tools.js` 里的 `ADV_TOOLS` 直接加一项
3. `tools.js` 里的 `ST_TOOLS`（酒馆内）或 `BRIDGE_TOOLS`（需桥接）

每项都是 `{name, kind, desc, params, run}`，系统提示会自动带上。需要新的服务端能力就在 `st-agent-bridge/index.js` 加路由。

## 已知限制

- 角色卡上 `edit-attribute` 不认的字段（如 `world` 绑定世界书）用 `char.merge` 写，v1.4 起已支持；V2 校验不通过时接口会 400，工具会把原因带回来
- 同一时间只跑一个任务，没有多会话隔离
- 默认直连模式下请求由酒馆内部管理，「停止」只能阻止下一步，正在跑的这次生成要等它返回
- `theme.list` 只能读主题名，切换主题仍要改 `powerUserSettings.theme` 并刷新（酒馆没暴露 `applyTheme`）
- 桥接的 `exec` 是给高级用户开的口子，默认建议只开读写
- 从 URL 安装后目录里会多出 `install.sh`、`README.md`、`st-agent-bridge/` 等文件，它们不参与运行；后续 `git pull` 可原地升级扩展本体
- v1.6 这一层依赖「酒馆助手」在线；它没装时 12 个 `th/preset/lore/msg.render/import/gen.models` 工具会报错，属预期
- v1.7 的 `audit.run` 会逐张卡查聊天档（`/api/characters/chats`），几百张卡时会慢几秒；用 `chatSample` 限制最近聊天采样量即可
- v1.7 的 `ext.maintain` 只对 git 安装的扩展有效；手动拷贝的目录会被明确拒绝（原因见上一节）
- v1.8 的 `snap.restore` 覆盖完必须刷新页面；`maid.report` 会遍历用户目录，文件极多时要几秒
- v1.8 的 `vec.*` 依赖酒馆配好的向量源；没配时 `vec.list` 返回 0，`vec.query` 才会真正报错（这是有意的，先探再查）
- v1.9 的 `api.models` 对 `kobold` / `textgenerationwebui` 这类不提供模型清单的后端会返回空（它们走 `/api/backends/text-completions`，模型靠手填）
- v1.9 的 `api.switch` 改 `main_api` 后要刷新页面才真正切过去（该变量是模块级的，`saveSettingsDebounced` 动不了它）
- v1.9 的 `translate.run` 里 `google` 在部分网络（含国内直连）会 500，换 `bing` 通常可用；`deepl` / `libre` 需要先在设置页配好端点或密钥
