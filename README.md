# ST Agent

在 SillyTavern **内部**运行的自主 Agent。它不是外挂脚本，也不跑在服务端：它直接躺在扩展目录里，用酒馆自己的 API、自己的数据、自己的扩展接口，把「一句话任务」拆成多轮工具调用，改完你卡里的东西还能回滚。

> 当前版本 **v1.11.0**（模块化重构版）。纯扩展安装，不改服务端；磁盘读写与 shell 需可选插件 `st-agent-bridge`。

---

## 能干什么

工具总数 **165 个**（未装桥接 165 / 装桥接 174）。按域分组：

| 域 | 典型工具 | 说明 |
|---|---|---|
| 角色卡 | `char.list` `char.get` `char.create` `char.update` `char.export` `char.import` | 改卡走 `merge-attributes` 顶层 + `data` 双写，v1.11 跳过 `UNSET_SENTINEL` 陷阱 |
| 世界书 | `world.*` `entry.*` | 条目用官方 `order` / `disable` 字段；写完可三档激活（常驻 / 关键词 / 向量） |
| 聊天 | `chat.*` `msg.*` `swipe` | 楼层重排、swipe 切换、批量写入与读取 |
| MVU 变量 | `var.get` `var.set` `var.delete` `lb.*` | 读写 `stat_data`，兼容楼层变量与全局变量 |
| 注入 | `inject.set` `inject.clear` `inject.list` | 世界书条目注入位置的绑定与清理 |
| 正则 | `regex.*` | 走官方落盘端点 `regex`，改完立即生效 |
| 预设 / 人格 | `preset.*` `persona.*` | 读取与写入，支持列表枚举 |
| 酒馆助手脚本 | `script.*` | 按 JSR 4.x 的 `content` / `id` 结构写，可列出脚本树 |
| STscript | `st.command` | 直接调用原生斜杠命令（`/char-update` 等） |
| 群聊 | `group.*` | 建群、加人、改设置 |
| 宏 / QR / 采样器 | `macro.*` `qr.*` `sampler.*` | 宏替换、快速回复按钮、采样参数 |
| 生成 | `gen.raw` `gen.tools` `token.*` `model.*` | 绕过预设直调模型、拉模型列表、切后端 |
| 备份 / 体检 | `snapshot` `backup` `vector` `stats` `scan` | settings 快照、聊天备份、向量库、data-maid 扫盘 |
| 磁盘（桥接） | `fs.read` `fs.write` `fs.edit` `fs.copy` `exec` | 需装 `st-agent-bridge` |

完整工具清单在面板里展开看，或 `window.STAgent.tools`。

---

## 安装

### 方式一：URL 安装（推荐）

酒馆 → 扩展 → 安装扩展 → 填：

```
https://github.com/Neohero521/st-agent
```

### 方式二：手动拷贝

把本仓所有文件放进：

```
SillyTavern/data/default-user/extensions/st-agent/
```

`manifest.json` 必须在扩展根目录。刷新页面，右下角出现「Agent」悬浮球即装好。

### 可选：磁盘与命令能力

`st-agent-bridge` 是独立的服务端插件，装进 `plugins/`，并在 `config.yaml` 里设：

```yaml
enableServerPlugins: true
```

不装也不影响卡、世界书、聊天这些核心能力，只是没有 `fs.*` 和 `exec`。

---

## 用起来

1. 点悬浮球（手机端：魔杖菜单 → ST Agent）。
2. 输入框交代任务，例如：
   - 「给『张一鸣』这张卡加一个世界书条目，关键词是『旧城区』，内容是……，常驻蓝灯」
   - 「把当前聊天里所有 MVU 变量的好感度 +1」
   - 「新建一个酒馆助手脚本，把楼层里的 `<status>` 渲染成状态条」
   - 「给这个正则加一条：把 `\[\[hp:(\d+)\]\]` 换成血条 HTML」
3. 看它自己拆步骤、调工具。默认 **只对高危操作弹窗确认**，写操作直接做，每步结果可展开。

### 三个关键开关（设置抽屉）

- **计划先批准**：模型先给 `<plan>`，你点「按此执行」才落盘。未批准时一条都不执行——写卡器同款语义。
- **批次确认**：同一轮多个写操作合并成一张卡，「全部执行 / 只执行安全的 / 全不执行」。
- **流式**：默认走酒馆 chat completion 逐字输出；遇到 Tauri / 老 WebView 的 `pipeThrough` 报错会自动降级为「全文 + 打字机」。

### 批量操作块

大改动可以一次提：

```
ops.plan   → 预演，列出 N 条会改什么，不动数据
ops.apply  → 真执行，逐条隔离错误，执行前自动快照，单批上限 40 条
ops.undo   → 回滚上一批
```

---

## 模块结构

v1.11 把原来的 34KB / 52KB / 55KB 三个巨文件按域拆成 16 个模块，改一处不碰全局：

```
index.js            入口壳：初始化 / jQuery 引导 / window.STAgent 调试出口
index-state.js      7 个模块级状态 + setter（ESM live binding 只读，写入走 setter）
index-boot.js       设置加载 / 桥接探活 / 连接配置 / generateRaw
index-stream.js     17 种后端模型字段映射 + 真流式 + 打字机
index-prompt.js     系统提示（含 ops 三拍协议）
index-loop.js       工具调用解析（3 种格式 + JSON 修复）/ 历史压缩 / 单步生成
index-risk.js       风险分级（3 高危 / 2 写入 / 1 只读）与参数摘要
index-agent.js      主循环 runAgent
index-ui.js         面板 DOM 与绑定
index-ui2.js        菜单入口 / 开关 / 日志 / 流式草稿 / 思考行
index-ui3.js        计划卡 / 批次审批 / 提交任务 / 连接配置填充
index-tools.js      聊天内工具注册

tools.js            ST 工具壳（32 个）+ tools-lib / set-a / set-b / set-c / bridge
adv-tools.js        进阶工具壳（47 个）+ adv-lib-core / world / ext / aux + set-a / set-b / set-c
```

`index-*.js` 之间只通过 `index-state.js` 的 setter 改状态，其余全走函数 import；`adv-lib-*` 四组互相引用但只在函数体内调用，顶层只有字面量，循环依赖安全。

---

## 调试

控制台里 `window.STAgent`：

```js
STAgent.tools                        // 当前全部工具定义
STAgent.executeTool({name:'char.list', args:{}})   // 单工具直调
STAgent.mockGenerate(async list => '<final>测试</final>')  // 造模型，不花钱
STAgent.run('帮我看看当前卡有几个世界书条目')
STAgent.riskOf({name:'char.delete'}) // 3
```

---

## 版本要点

- **v1.11** 按 ST 1.19 源码逐条校正写入路径：世界书 `order` / `disable`、条目三档激活、角色卡 `merge-attributes` 双写、JSR 脚本 `content` / `id`、正则与预设官方端点。
- **v1.10** 批量操作块（plan / apply / undo）、批次级确认、计划卡批准制、逐字流式与思考行。
- 细节见 `docs/v1.11-write-paths.md`、`docs/v1.10-batch-ops.md`。

## 许可

个人使用。禁止用于批量刷号、绕过平台限制等用途。
