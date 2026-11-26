# ST Agent · 酒馆内部的自主 Agent

装进 SillyTavern 扩展目录就能用：在酒馆里开一个 Agent 面板，模型自己规划、自己调工具、多轮执行到任务完成。改角色卡、改世界书、翻聊天记录、调设置、加正则、跑 STscript——全走酒馆自己的接口，不需要动服务端，不需要改 `config.yaml`。

## 安装（30 秒）

**方式一：用酒馆自带的「从 URL 安装扩展」（推荐）**

扩展 → 安装扩展 → 粘贴仓库地址：

```
https://github.com/Neohero521/st-agent
```

仓库根目录就是扩展本体（`manifest.json` / `index.js` / `tools.js` / `style.css` 均在根上），酒馆克隆后直接识别，不需要手动挑子目录。装完刷新页面，右下角出现「Agent」悬浮球。

**方式二：手动复制四个文件**

把仓库根目录的 `manifest.json`、`index.js`、`tools.js`、`style.css` 放进

```
<酒馆根目录>/data/<你的用户名>/extensions/st-agent/
```

没有目录就自己建。`tools.js` 必须一起放（被 `index.js` import）。刷新页面即可。

**方式三：一条命令（本目录 / zip 版）**

```bash
bash install.sh /path/to/SillyTavern          # Linux / macOS / Termux
```

```powershell
.\install.ps1 -StDir "C:\SillyTavern"          # Windows
```

装完在面板设置里选一个「模型配置」（就是酒馆连接管理器里已有的 API），然后直接下指令。

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

## 可选增强：磁盘桥接

上面这些已经覆盖「酒馆内部文件」的全部 CRUD。如果你还想要**任意路径读写、grep 整个装包、跑 shell 命令**，再装 `st-agent-bridge`（服务端插件）：

1. 把 `st-agent-bridge` 放进 `<酒馆根目录>/plugins/`
2. `config.yaml` 里设 `enableServerPlugins: true`
3. 重启酒馆

面板会自动检测到它在线，多出 9 个工具：`fs.info` `fs.list` `fs.read` `fs.write` `fs.edit` `fs.copy` `fs.glob` `fs.grep` `exec`。不装也完全不影响主功能。

桥接侧的安全设计：路径白名单（酒馆根 + `data/`，可用 `config.json` 的 `extraRoots` 追加）；写前自动备份到 `data/_agent/backups/<时间戳>/`；全量审计 `data/_agent/audit.jsonl`；`allowExec` / `allowDelete` 可单独关。

## 怎么用

- 直接说人话：「把 Eldoria 里所有 constant 条目按 insertion_order 重排」「找出提到旧角色名的聊天，列出来」「清掉正则里没启用的条目」
- 面板按 `你 → 计划 → 工具调用（可展开看原始结果）→ 结论` 流式展示
- 审批三档：仅高危 / 写操作 / 每步确认（设置里切）
- 步数上限默认 20，随时「停止」

## 常见问题

**从 URL 安装报 500**
酒馆的安装接口只读“克隆目录根”的 `manifest.json`，根上没有就一律 500。如今仓库根已经有了；如果仍报 500，看酒馆服务端日志，基本是主机没装 `git` 或到 GitHub 的网络不通（此时改用手动复制）。

**悬浮球没出现**
路径放错了。必须是 `data/<用户名>/extensions/st-agent/`，且目录里直接能看到 `manifest.json` 与 `index.js`（不是再多一层 st-agent/）。放对后 F12 控制台应能看到 `STAgent`。

**面板里没有模型配置**
先去酒馆「连接管理器」建一个 API 配置，再回面板选。

**工具报 403 / CSRF**
酒馆开了 CSRF 保护时，扩展用的是酒馆自己的请求封装，正常不会触发；如果你手动改过 `request.js` 或用了反向代理改写，需要放行。

**想确认装了几个工具**
F12 执行 `STAgent.tools.length`：没装桥接是 33，装了是 42。

## 开发

```js
STAgent.tools                              // 当前可用工具（随桥接状态变化）
STAgent.executeTool({name:'world.list', args:{}})
STAgent.mockGenerate(fn)                   // 用自定义函数代替模型，离线调试循环
STAgent.run('列出所有世界书')
```

加工具：`tools.js` 里 `ST_TOOLS`（酒馆内）或 `BRIDGE_TOOLS`（需桥接）各加一项 `{name, kind, desc, params, run}`，系统提示会自动带上；需要新的服务端能力就在 `st-agent-bridge/index.js` 加路由。

## 已知限制

- 角色卡 `world`（绑定世界书）字段酒馆的 `edit-attribute` 接口不认，暂不支持写入，走 UI 或 STscript
- 同一时间只跑一个任务，没有多会话隔离
- 桥接的 `exec` 是给高级用户开的口子，默认建议只开读写
- 从 URL 安装后目录里会多出 `install.sh`、`README.md`、`st-agent-bridge/` 等文件，它们不参与运行；后续 `git pull` 可原地升级扩展本体
