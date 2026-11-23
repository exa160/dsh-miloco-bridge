# 架构

## 1. 两半 + 专用预设

DSH 的插件有作用域：全局插件对所有会话可见；挂在 Agent preset 里的插件只对该预设的会话可见。
本插件利用这一点，把“必须常驻的基础设施”和“只属于家庭助手的工具/技能”拆开。

```
DSH Host
├── dsh-miloco-bridge（全局）
│    ├─ webhook 入站
│    ├─ 设置 API
│    ├─ 一键部署 / 连接
│    └─ 浏览器设置页
└── preset「miloco」
     └── dsh-miloco-bridge/tools
          ├─ 30 只读 + 26 写 + dsh_deliver_message
          └─ 18 Skill
```

### 为什么必须拆

- 推送入口必须全局存在，否则 Miloco 的事件在“没人在用 Miloco 预设”时会丢失；
- 设备控制等工具如果全局注册，会出现在每个普通对话的工具列表里，既浪费 token，
  也让无关对话获得动家里的能力；
- Skill 是注入上下文的，全局注册会污染其他会话的人设与提示词。

### 预设插件清单必须自己维护（易漏项）

DSH 的 Agent 预设**没有继承机制**：`PresetDefinition` 只有 `id` / `name` /
`description` / `order` / `plugins` 五个字段，没有 `extends` / `base` / `mixin`。
预设挂载时把 `plugins` 数组整体交给一棵**独立的** Loader 树
（`mountPreset()` → `prepareProfileEntries()`），与宿主层的 Loader 树互不影响：
宿主的 `disabled: true` 不会传染进来，但宿主**也不会**替预设补上任何东西。

官方四个预设（`standard` / `cordis` / `ptc` / `minimal`）因此都是逐字手抄的完整清单。

宿主层**有意**禁用了以下三项（`dsh-web-app/cordis.patch.yml`）：

```yaml
- id: compaction-basic      # 压缩后端归预设所有
  disabled: true
- id: command-compact       # /compact 命令归预设所有
  disabled: true
- id: tool-result-pruner    # 工具结果裁剪归预设所有
  disabled: true
```

理由是 token meter 的上下文投影表是进程级的，压缩后端必须与消费方同作用域，
否则 meter 会变成「碰巧挂了哪些预设」的函数。**代价是每个自定义预设必须自己声明
压缩组**——漏写不会报错，只会**静默失效**：

- `/compact` 命令从未注册 → 用户发的 `/compact` 被当成普通消息塞给模型；
- `agent/pre-step` 上的自动压缩无人执行 → 上下文永远降不下来；
- 兜底路径只处理 `CONTEXT_WINDOW_EXCEEDED`，管不了上游的 `max_output_tokens` 截断。

> 历史教训：本仓库的 `miloco` 预设从 2026-10-28 首个 commit 起就没抄压缩组，
> 直到 2026-11-24 才补上。症状是会话变长后反复「输出被截断」，且每次
> `usage.outputTokens` 恰好是 16——pi-ai 把有效输出上限钳到了
> `max(1, contextWindow - input - margin)`，输入过长时落到 1，再被
> openai-responses 的下限抬回 16。

**升级 DSH 时的检查清单**：对比官方 `standard` 预设的 `plugins` 清单，
确认压缩组、`agent-instructions`、`time-context` 等公共设施仍在
`cordis.patch.yml` 的 `preset-miloco` 里。`test/core.test.js` 有对应的回归测试。

## 2. 文件结构

```
lib/
├── index.js            全局半边：webhook + 设置 API 的装配
├── tools-entry.js      预设半边：工具/技能/投递工具的装配
├── tools.js            56 个原生工具定义
├── skills.js           SKILL.md 读取与 ctx.skills.register
├── miloco-client.js    Miloco HTTP 客户端（连接优先级、envelope 解包）
├── push.js             入站推送：鉴权、目标解析、会话恢复、等待 turn
├── home.js             家庭工作区：创建目录、注册、置顶、改名
├── settings-api.js     设置 API 路由
├── deploy.js           一键部署（启动已有 / 下载 release 安装器 / 写 adapter）
├── uninstall.js        卸载 Miloco（停服务 / 移除 adapter / 可选删数据或源码）
├── perception.js       感知事件优先级解析与阈值过滤
├── client.js           浏览器设置页（无构建步骤）
├── overlay.js          运行时 overlay（连接/令牌/目标），0600
├── state.js            共享状态（模式、最近会话）
├── deliver-tool.js     dsh_deliver_message
├── profile-config.js   profile patch 的定点改写
└── paths.js            ~ 与 $DSH_HOME 展开
skills/                 18 个原创 Skill
adapter/dsh_adapter.py  Miloco 侧 agent_platform adapter
```

## 3. 连接解析

`miloco-client.js` 按以下优先级解析后端：

1. `$DSH_HOME/miloco-plugin.json` 的 `connection`
2. 插件静态配置 `baseUrl` / `token`
3. `$MILOCO_HOME/config.json` 的 `server.url` / `server.token`
4. `http://127.0.0.1:1810`

第 1 层是运行时层，Web 设置页“连接已有的 Miloco”写的就是它，所以两个半边
（全局与预设）都能立即读到新连接，不需要重启。

### 3.1 运行时 overlay

`$DSH_HOME/miloco-plugin.json`（0600）是唯一可在运行时改写的配置层：

| 字段 | 含义 |
|---|---|
| `connection.baseUrl` / `connection.token` | 连接覆盖，优先于静态配置 |
| `push.token` | 入站 Bearer；为空时回退静态 `push.token` |
| `push.target.mode` | 推送投递方式：`archive`（默认）/ `session` |
| `push.target.sessionId` | `session` 模式下的目标会话；空 = 上次触发 Miloco 的会话 |
| `home.dir` | 家庭工作区目录，覆盖静态 `workspace.dir` |
| `push.model` / `push.perception.minLevel` | 模型覆盖与感知阈值 |

写入是合并式的：只改一个字段不会丢掉其他字段。

## 4. 家庭工作区与概览

`home.js` 维护一个家庭工作区：概览页「新建家庭会话」建出的会话、以及推送创建/复用的
归档会话，工作目录都是它。会话本身仍可带自己的 cwd——例如手动把「Miloco 家庭助手」
预设挂到别的工作区的会话上，那个会话保留自己的 workspace cwd，不会迁到这里。

- 目录解析顺序：`overlay.home.dir` → 静态 `workspace.dir` →
  `$DSH_HOME/plugin-data/dsh-miloco-bridge/home`；
- 启动时创建目录、注册为宿主 Workspace、改名为 `workspace.title`（默认「家庭助手」），
  每次 `ensure()` 都会重新置顶，避免被后建的工作区挤到下面；
- 设置页“修改目录”写 overlay 后**注册一个新的工作区**；旧目录的工作区注册
  **不会**被移除，旧目录与其中的会话都不受影响（与设置页同一段文案）；
- 设置页“启用置顶工作区”写 `overlay.workspace.enabled`（默认 `true`）：关闭后
  `ensure()` 调 `workspaceRegistry.delete()` 注销工作区，其中的会话随之落到「未分组」，
  重新打开时再注册并置顶；
- 宿主没有 `workspaceRegistry` 时只建目录，`workspaceId` 为空，不报错。

概览页（侧栏「Miloco 家庭助手」）读 `GET /home/overview`：后端状态与版本、家庭概览统计
（账号、设备、摄像头、规则/任务、感知源、token 用量）、设备与房间分组、最近事件、
最近推送记录、归档会话是否存在。每个远端接口独立结算，单个接口不可达不会涂黑整页。

`/home/overview` 另带一个 `setup` 段，描述“装好没有”：连接是否可达、账号是否绑定、
推送令牌是否就绪、Miloco 自己的页面地址。页面按它分成四种互斥形态：

| 形态 | 触发条件 | 版式 |
|---|---|---|
| 加载中 | 还没有第一次响应 | 整页居中的转圈提示（不渲染仪表盘头部） |
| 读取失败 | 整个请求失败 | 整页居中的错误说明 + 「重试」/「打开配置」 |
| 初始化 | 连不上 Miloco，或连上了但账号未绑定 | 整页居中的三步清单 + 绑定入口 |
| 仪表盘 | 连得上且账号已绑定 | 家庭概览、设备房间、事件与推送 |

未配置与已配置**不共用一套版式**：没有账号时仪表盘本来就是空的，不如给一页独立的
初始化引导。绑定账号有两条路，按推荐顺序排：

1. 「在 Miloco 中绑定 ↗」——打开 Miloco 自己的页面，用它现成的绑定向导（推荐）；
2. 「在本页绑定」——插件代走一遍：`POST /miot/bind` 拿小米授权链接，用户在小米页
   授权后把回调页给出的整段内容粘回来，插件解出 `code`/`state` 再交给 Miloco。

插件只与本机 Miloco 通信，不上传账号、令牌或家庭数据；授权码是一次性凭据，
只转发给 Miloco，不落日志、不回显给浏览器。

## 5. 设置 API

前缀：`/dsh-miloco-bridge/api`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 模式、连接、家庭概览、会话列表、模型目录、部署状态 |
| GET | `/sessions` | 实时 DSH 会话 + 历史 Miloco 会话 |
| POST | `/target` | 写推送目标（会话 + 可选模型） |
| POST | `/mode` | 写运行模式 |
| GET | `/deploy` | 部署状态与日志 |
| POST | `/deploy` | 启动部署 |
| POST | `/connect` | 写连接与推送令牌，立即生效 |
| GET | `/home` | 家庭工作区快照（路径、标题、dirSource、归档会话 id、enabled） |
| POST | `/home` | 修改家庭工作区目录或置顶开关（写 overlay，注册/注销工作区） |
| GET | `/home/overview` | 家庭概览聚合（状态、版本、概览统计、设备、事件、推送记录）+ `setup` 段（连接/账号/推送是否就绪） |
| POST | `/miot/bind` | 取小米授权链接（`{oauthUrl, state}`），供初始化页绑定账号 |
| POST | `/miot/authorize` | 提交回调页给出的授权内容，解出 `code`/`state` 交给 Miloco 完成绑定 |

写操作要求同源；令牌不会回显给浏览器。

## 6. 状态文件

`$DSH_HOME/miloco-plugin.state.json`：

```json
{
  "mode": "readonly",
  "lastSession": "miloco-agent-main-miloco",
  "lastSessionAt": 1793119479596,
  "sessions": [
    { "id": "miloco-agent-main-miloco", "at": 1793119479596 }
  ],
  "pushLog": [
    { "at": 1793119480000, "title": "感知", "summary": "门口有人停留", "sessionId": "miloco-archive", "status": "ok", "runId": "…" }
  ]
}
```

- 两个半边在不同作用域，不能共享内存，所以用文件；
- `lastSession` 由工具执行时记录：`exec.agent.session.header.id`；
- 同一会话 60 秒内只写一次，避免频繁落盘；
- `pushLog`：最近 20 条推送元数据（时间、标题、摘要、目标会话、状态、runId），新的在前；
  解析目标失败的那次推送不记录；
- 只存会话 id 与时间，不存对话内容。

## 7. 推送协议

### 7.1 入站

```http
POST /miloco/webhook
Authorization: Bearer <overlay.push.token 或 push.token>
Content-Type: application/json

{ "action": "agent",
  "payload": {
    "message": "…",
    "sessionKey": "agent:main:miloco",
    "lane": "miloco-rule",
    "traceId": "…",
    "idempotencyKey": "…",
    "timeoutMs": 120000
  } }
```

响应：

```json
{ "code": 0, "message": "",
  "data": { "runId": "…", "status": "ok", "sessionId": "…", "source": "last-miloco-session", "reply": "…" } }
```

- 无令牌：`503`（fail closed）
- 令牌不匹配：`401`
- 业务错误：HTTP 200 + `code: 1`
- `action: "get_trace"`：返回已知结果或 `status: "unknown"`
- `action: "reset_sessions"`：清掉对应 sessionKey 的记忆

### 7.2 目标解析

```
mode = overlay.push.target.mode || push.target.mode || 'archive'

mode = archive → sessionId = miloco-archive
mode = session → sessionId = overlay.push.target.sessionId
                          || static push.target.sessionId
                          || state.lastSession
                          || derive(sessionKey)
```

- `archive`（默认）：所有推送进同一个专用归档会话 `miloco-archive`，首次推送时创建，
  带家庭工作区目录与 `miloco` 预设，标题「Miloco 推送归档」，之后一直复用；
- `session`：显式配置的会话不存在 → 创建它；
- 默认的 lastSession 已被删除 → 回退到派生 id，再创建；
- 新建会话默认挂 `miloco` 预设（可通过 `push.target.agentPreset` 改）。

### 7.3 感知过滤

推送到达 DSH 后、解析目标会话前，先按感知优先级过滤：

```
push.perception.minLevel = all | low | medium | high
```

- 从 payload 的 `urgency` / `priority` / `perception.urgency` 读取，或解析消息里的
  `事件优先级：high|medium|low`；一个批次取最高值；
- 低于阈值的事件返回 `{status:"filtered"}`，**不恢复/创建会话、不产生 LLM turn**；
- `ignore` 始终丢弃；
- 规则、任务、onboarding、普通对话事件没有 urgency，始终放行；
- Miloco adapter 会把解析出的 urgency 放进 payload；即使使用旧 adapter，
  DSH 也能从消息文本里解析。

### 7.4 模型

- `provider` 与 `model` 都为空：**不调用** `selectModel`，完全跟随会话；
- 两者都有：`selectModel`，只影响该会话；
- 只填一个：设置页拒绝；工具层也拒绝，避免“半配置”导致误判。

### 7.5 等待 turn

`waitForResult: true` 时：

1. 记录本次 `turn/start` 的 turn 号；
2. 收集 `assistant/message` 文本；
3. 只有同一 turn 的 `turn/end` 才结算；
4. 超时返回 `status: "timeout"`，不阻塞后续推送。

### 7.6 单归档会话的限制

所有推送默认进入同一个归档会话，因此前一次 turn 还没结束时到达的推送会和它挤在同一条会话里：
等待结果的调用可能报 `status: "timeout"`，也可能把回复归到另一次推送头上。推送本身仍会送达会话，
只是“哪条回复属于哪次推送”不再可辨。需要按次对齐回复时，把投递方式改为指定会话，
或把连发的推送拉开间隔。

### 7.7 幂等

`idempotencyKey`（或 `traceId`）在 10 分钟内只执行一次；重复请求返回相同 `runId` 并带 `idempotent: true`。

## 8. adapter

`adapter/dsh_adapter.py` 由 Miloco 的 `agent_platform` loader 动态加载：

- 只要求 `name` / `send_turn` / `read_trace_meta`；
- 配置从 `$MILOCO_HOME/agent_platform/dsh/config.yaml` 或环境变量读；
- 可选把家庭档案渲染文本拼在消息前（`include_home_profile`）；
- 传输失败抛 `AdapterTransportError`（后端同进程时复用其公共异常类）；
- 不 import Miloco 业务模块，不复制上游代码。

## 9. 一键部署

`deploy.js` 的步骤：

1. 健康检查 `127.0.0.1:1810`；
2. 已装 Miloco → `miloco-cli service start`；
3. 未装 → 下载官方 release `install.sh`（直连失败时走 GitHub 镜像）；
4. 以 headless agent 模式运行 `install.sh --agent-prepare` + `--agent-finish`
   （`--skip-openclaw --agent-platform=openclaw --lang=zh`）；
5. 启动服务并等待健康；
6. 安装 adapter，写令牌；
7. 写 overlay 的连接与推送令牌。

所有子进程用 `spawn(command, args)`，不做 shell 字符串拼接。
`--agent-platform=openclaw` 只用于通过上游平台的非交互检测，
`--skip-openclaw` 保证不安装 OpenClaw 插件，实际由 DSH adapter 接管。

镜像模式的一键升级复用同一 release 安装器：下载 → `--agent-prepare` →
`--agent-finish` → 启动服务 → 写 adapter/webhook。升级状态与日志独立于部署，
日志在 `$MILOCO_HOME/log/dsh-miloco-upgrade.log`；命令参数和子进程输出都会脱敏。

## 10. 安全边界

- Web 设置页的写操作同源校验；
- 入站 webhook 常量时间比较 Bearer；
- overlay 0600；
- 只读模式的写工具不注册；
- 不记录对话正文到状态/overlay；
- 不内置任何真实凭据。
