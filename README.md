# ST Agent · 酒馆内部的自主 Agent

装进 SillyTavern 扩展目录就能用：在酒馆里开一个 Agent 面板，模型自己规划、自己调工具、多轮执行到任务完成。改角色卡、改世界书、翻聊天记录、调设置、加正则、跑 STscript——全走酒馆自己的接口，不需要动服务端，不需要改 `config.yaml`。

## 安装（30 秒）

**方式一：用酒馆自带的「从 URL 安装扩展」（推荐）**

扩展 → 安装扩展 → 粘贴仓库地址：

```
https://github.com/Neohero521/st-agent
```

仓库根目录就是扩展本体（`manifest.json` / `index.js` / `tools.js` / `adv-tools.js` / `style.css` 均在根上），酒馆克隆后直接识别，不需要手动挑子目录。装完刷新页面，右下角出现「Agent」悬浮球。

**方式二：手动复制文件**

把仓库根目录的 `manifest.json`、`index.js`、`tools.js`、`adv-tools.js`、`style.css` 放进

```
<酒馆根目录>/data/<你的用户名>/extensions/st-agent/
```

没有目录就自己建。`tools.js` / `adv-tools.js` 必须一起放（被 `index.js` import）。刷新页面即可。

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

## 可选增强：磁盘桥接

上面这些已经覆盖「酒馆内部文件」的全部 CRUD。如果你还想要**任意路径读写、grep 整个装包、跑 shell 命令**，再装 `st-agent-bridge`（服务端插件）：

1. 把 `st-agent-bridge` 放进 `<酒馆根目录>/plugins/`
2. `config.yaml` 里设 `enableServerPlugins: true`
3. 重启酒馆

面板会自动检测到它在线，多出 9 个工具：`fs.info` `fs.list` `fs.read` `fs.write` `fs.edit` `fs.copy` `fs.glob` `fs.grep` `exec`。不装也完全不影响主功能。

桥接侧的安全设计：路径白名单（酒馆根 + `data/`，可用 `config.json` 的 `extraRoots` 追加）；写前自动备份到 `data/_agent/backups/<时间戳>/`；全量审计 `data/_agent/audit.jsonl`；`allowExec` / `allowDelete` 可单独关。

## 怎么用

- 直接说人话：「把 Eldoria 里所有 constant 条目按 insertion_order 重排」「找出提到旧角色名的聊天，列出来」「清掉正则里没启用的条目」「把这章的 MVU 变量按楼层补齐」
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
F12 执行 `STAgent.tools.length`：基础 70（含进阶/自主层），装桥接是 79。

## 开发

```js
STAgent.tools                              // 当前可用工具（随桥接状态变化）
STAgent.executeTool({name:'var.get', args:{scope:'chat'}})
STAgent.mockGenerate(fn)                   // 用自定义函数代替模型，离线调试循环
STAgent.run('列出所有世界书')
```

加工具：`tools.js` 里的 `ST_TOOLS`（酒馆内）或 `BRIDGE_TOOLS`（需桥接），以及 `adv-tools.js` 里的 `ADV_TOOLS`，各加一项 `{name, kind, desc, params, run}`，系统提示会自动带上；需要新的服务端能力就在 `st-agent-bridge/index.js` 加路由。

## 已知限制

- 角色卡 `world`（绑定世界书）字段酒馆的 `edit-attribute` 接口不认，暂不支持写入，走 `world.get` + UI 或 STscript
- 同一时间只跑一个任务，没有多会话隔离
- 默认直连模式下请求由酒馆内部管理，「停止」只能阻止下一步，正在跑的这次生成要等它返回
- 桥接的 `exec` 是给高级用户开的口子，默认建议只开读写
- 从 URL 安装后目录里会多出 `install.sh`、`README.md`、`st-agent-bridge/` 等文件，它们不参与运行；后续 `git pull` 可原地升级扩展本体
