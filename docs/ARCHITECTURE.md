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

## 2. 文件结构

```
lib/
├── index.js            全局半边：webhook + 设置 API 的装配
├── tools-entry.js      预设半边：工具/技能/投递工具的装配
├── tools.js            56 个原生工具定义
├── skills.js           SKILL.md 读取与 ctx.skills.register
├── miloco-client.js    Miloco HTTP 客户端（连接优先级、envelope 解包）
├── push.js             入站推送：鉴权、目标解析、会话恢复、等待 turn
├── settings-api.js     设置 API 路由
├── deploy.js           一键部署（启动已有 / clone + 安装 / 写 adapter）
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

## 4. 设置 API

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

写操作要求同源；令牌不会回显给浏览器。

## 5. 状态文件

`$DSH_HOME/miloco-plugin.state.json`：

```json
{
  "mode": "readonly",
  "lastSession": "miloco-agent-main-miloco",
  "lastSessionAt": 1793119479596,
  "sessions": [
    { "id": "miloco-agent-main-miloco", "at": 1793119479596 }
  ]
}
```

- 两个半边在不同作用域，不能共享内存，所以用文件；
- `lastSession` 由工具执行时记录：`exec.agent.session.header.id`；
- 同一会话 60 秒内只写一次，避免频繁落盘；
- 只存会话 id 与时间，不存对话内容。

## 6. 推送协议

### 6.1 入站

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

### 6.2 目标解析

```
sessionId = overlay.target.sessionId
          || static push.target.sessionId
          || state.lastSession
          || derive(sessionKey)
```

- 显式配置的会话不存在 → 创建它；
- 默认的 lastSession 已被删除 → 回退到派生 id，再创建；
- 新建会话默认挂 `miloco` 预设（可通过 `push.target.agentPreset` 改）。

### 6.3 感知过滤

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

### 6.4 模型

- `provider` 与 `model` 都为空：**不调用** `selectModel`，完全跟随会话；
- 两者都有：`selectModel`，只影响该会话；
- 只填一个：设置页拒绝；工具层也拒绝，避免“半配置”导致误判。

### 6.5 等待 turn

`waitForResult: true` 时：

1. 记录本次 `turn/start` 的 turn 号；
2. 收集 `assistant/message` 文本；
3. 只有同一 turn 的 `turn/end` 才结算；
4. 超时返回 `status: "timeout"`，不阻塞后续推送。

### 6.6 幂等

`idempotencyKey`（或 `traceId`）在 10 分钟内只执行一次；重复请求返回相同 `runId` 并带 `idempotent: true`。

## 7. adapter

`adapter/dsh_adapter.py` 由 Miloco 的 `agent_platform` loader 动态加载：

- 只要求 `name` / `send_turn` / `read_trace_meta`；
- 配置从 `$MILOCO_HOME/agent_platform/dsh/config.yaml` 或环境变量读；
- 可选把家庭档案渲染文本拼在消息前（`include_home_profile`）；
- 传输失败抛 `AdapterTransportError`（后端同进程时复用其公共异常类）；
- 不 import Miloco 业务模块，不复制上游代码。

## 8. 一键部署

`deploy.js` 的步骤：

1. 健康检查 `127.0.0.1:1810`；
2. 已装 Miloco → `miloco-cli service start`；
3. 未装 → `git clone` 官方仓库到 `$DSH_HOME/plugin-data/dsh-miloco-bridge/xiaomi-miloco`；
4. 运行 `scripts/install.sh --dev --skip-openclaw`；
5. 启动服务并等待健康；
6. 安装 adapter，写令牌；
7. 写 overlay 的连接与推送令牌。

所有子进程用 `spawn(command, args)`，不做 shell 字符串拼接；仓库地址必须是 `https://`。

## 9. 安全边界

- Web 设置页的写操作同源校验；
- 入站 webhook 常量时间比较 Bearer；
- overlay 0600；
- 只读模式的写工具不注册；
- 不记录对话正文到状态/overlay；
- 不内置任何真实凭据。
