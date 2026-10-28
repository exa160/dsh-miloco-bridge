# 验证手册

以下命令都可直接复制执行。分三层：

1. **离线**：不启动 DSH / Miloco，验证模块、工具、技能、推送语义；
2. **真实 DSH**：用隔离的 `DSH_HOME` 启动，验证插件装载、设置 API、webhook、UI；
3. **真实 Miloco**：只读接口 + 推送鉴权。

---

## 1. 离线测试

```bash
cd dsh-miloco-bridge
npm test
# 50 tests, 0 fail
npm run selftest
# 8 项离线自检
python3 -m py_compile adapter/dsh_adapter.py
```

覆盖：

- 连接/overlay/state 的路径与权限（`0600`）；
- 只读 30 工具、管家 56 工具；
- 推送目标：上次会话 / 显式会话 / 派生会话 / 模型留空不调 `selectModel`；
- 感知过滤：结构化 urgency、文本“事件优先级”、批量取最高、ignore、阈值比较；
- webhook：无令牌 503、错令牌 401、正确令牌通过、幂等、turn 等待；
- 设置 API：概览、会话列表、`/target`、`/connect`、`/mode`、`/uninstall`；
- 18 个 Skill 可解析、不引用 `openclaw`/`miloco-cli`、不做身份断言；
- 客户端 bundle 通过 `node --check`；
- adapter 可独立编译；
- 卸载：确认文本、路径白名单、停止服务、移除 adapter、清空连接/令牌。

---

## 2. 隔离 DSH 装载

不要动现有 profile：

```bash
export DSH_HOME=/tmp/dsh-miloco-verify-dsh
rm -rf "$DSH_HOME"
dsh plugin --profile web add "link:$PWD"

dsh --profile web --dump-config | grep -A20 "id: dsh-miloco-bridge"
dsh --profile web --dump-config | grep -A20 "id: preset-miloco"
```

预期看到：

- `dsh-miloco-bridge` 条目：`push.target.agentPreset: miloco`；
- `preset-miloco` 条目：`plugins[0].name: dsh-miloco-bridge/tools`。

启动：

```bash
dsh --profile web --host 127.0.0.1 --port 3086 --no-open
# 日志会打印带 token 的 URL
```

### 2.1 设置 API

```bash
curl -s http://127.0.0.1:3086/dsh-miloco-bridge/api/status | python3 -m json.tool
```

预期：

- `ok: true`；
- `overview.account.nickname`、`deviceCount`、`cameraCount`、`tokenTotal`；
- `sessions` 是数组；
- **没有** `defaultModel` 字段；
- `overlay.connection.tokenSet` / `overlay.push.tokenSet` 只返回布尔值。

### 2.2 webhook fail closed

```bash
curl -s -X POST http://127.0.0.1:3086/miloco/webhook \
  -H 'content-type: application/json' \
  -d '{"action":"agent","payload":{"message":"x"}}'
# {"code":1,"message":"推送令牌未配置，拒绝所有入站推送",...}  (HTTP 503)
```

### 2.3 带令牌

```bash
cat > "$DSH_HOME/miloco-plugin.json" <<'JSON'
{
  "connection": { "baseUrl": "", "token": "" },
  "push": {
    "token": "verify-token",
    "target": { "sessionId": "" },
    "model": { "provider": "", "model": "", "reasoningEffort": "" }
  }
}
JSON
```

重启 DSH，然后：

```bash
curl -s -X POST http://127.0.0.1:3086/miloco/webhook \
  -H 'authorization: Bearer wrong' -H 'content-type: application/json' \
  -d '{"action":"agent","payload":{"message":""}}'
# {"code":1,"message":"unauthorized",...}  (HTTP 401)

curl -s -X POST http://127.0.0.1:3086/miloco/webhook \
  -H 'authorization: Bearer verify-token' -H 'content-type: application/json' \
  -d '{"action":"agent","payload":{"message":""}}'
# {"code":1,"message":"payload.message 为空 ..."} —— 已通过鉴权
```

空消息用于验证鉴权，不会触发真实 LLM。

### 2.4 浏览器 UI

1. 打开日志里的 `http://127.0.0.1:3086/?token=…`；
2. 设置 → 内置插件 → **Miloco**；
3. 应看到：
   - 第一格：家庭概览（账号、设备、摄像头、规则/任务、感知、token）；
   - 第二格：运行状态，后端地址是可点击链接，含「卸载 Miloco」入口；
   - 运行模式：只读 / 管家（不再有聊天模式），每条模式说明独立换行；
   - 「查看模式说明与用法」可展开等价说明（DSH 只给内置预设提供帮助弹窗）；
   - 推送目标：会话输入框（可下拉）、模型下拉只有「跟随该对话自己选的模型」；
   - 推理强度只在所选模型确实提供 efforts 时显示；没有选项时整行隐藏；
   - 「感知等级」可选择全部 / 低及以上 / 中及以上 / 仅高优先级；
4. 新建会话的预设菜单里应出现 **Miloco 家庭助手**。

本次实现已按上述步骤实测通过（DSH `0.2.1-rc.4`）。

---

## 3. 真实 Miloco 只读接口

```bash
MILOCO_BASE_URL=http://192.0.2.10:1810 \
MILOCO_TOKEN='<server.token>' \
node tools/verify-readonly.mjs
```

预期：`24/24 个只读接口通过`。该脚本不会控制设备、触发场景、发通知或建任务。

真实环境结果（2026-10-28）：24/24 接口通过；账号已绑定、感知引擎运行中。
账号昵称、设备数量与 token 用量属于家庭隐私，已脱敏，不在仓库中列出。

### 3.1 写接口契约审计

从运行中的 Miloco 读取 `/openapi.json`，用 stub client 执行全部 56 个工具
（其中 52 个会发 HTTP 请求），逐项比对 method / path / query / body 与 OpenAPI
schema（required、additionalProperties、enum）。所有 HTTP 工具的路径与方法都存在；本轮修复了：

- `POST /api/tasks` 的 v2 契约（`task_id` + `description`，不再接受 `kind/content/name`）
- 新增 `POST /api/tasks/{id}/record` 的 `miloco_task_record_init`
- `POST /api/rules` 改为结构化 `condition/actions`
- 设备列表的 `room` 改为本地过滤（后端没有该查询参数）
- `candidates:write` 强制 `date`，`commit` 去掉多余请求体
- 宠物参照图 multipart 字段改为 `crops`

对应的离线契约测试见 `test/tools-contract.test.js`。真实写操作仍未在家庭设备上执行。

---

## 4. 推送闭环验证

### 4.1 目标语义

| 配置 | 预期 |
|---|---|
| `target.sessionId=""`，最近调用过 `miloco_*` 工具 | 投到该会话 |
| `target.sessionId=""`，没有记录 | 投到 `miloco-agent-main-miloco`（按 `sessionKey` 派生） |
| `target.sessionId="<id>"` | 投到该会话；不存在则创建并挂 `miloco` 预设 |
| `model` 空 | 不调用 `selectModel`，跟随会话 |
| `provider+model` | 对目标会话调用 `selectModel` |

离线测试已覆盖全部五种情况；真实环境可用下面的 curl 检查（`message` 为空不会触发 LLM）：

```bash
curl -s -X POST http://127.0.0.1:3086/miloco/webhook \
  -H 'authorization: Bearer verify-token' \
  -H 'content-type: application/json' \
  -d '{"action":"agent","payload":{"message":"","sessionKey":"agent:main:miloco"}}'
```

### 4.2 Miloco 侧

```bash
miloco-cli config get agent.platform
# dsh
miloco-cli config get agent.webhook_url
# http://<dsh-host>:3080/miloco/webhook
```

在 Miloco 面板触发一次规则或任务，DSH 日志应出现：

```text
dsh-miloco-bridge: push delivery failed ...   # 仅在失败时
```

成功时 Miloco 的 Agent 记录里能看到对应 turn。

---

## 5. 预设隔离验证

1. 新建一个**标准模式**会话，随便问一句；
2. 查看该会话的请求头/工具列表：不应出现任何 `miloco_*`；
3. 新建一个 **Miloco 家庭助手** 会话：
   - 只读模式：30 个 `miloco_*`；
   - 管家模式：56 个 `miloco_*` + `dsh_deliver_message`。

如果标准会话出现 `miloco_*`，检查 `preset-miloco` 是否被正确装载。

> DSH `0.2.1-rc.4` 的「模式说明 / 如何使用」按钮只为内置预设（standard/ptc/minimal/cordis）硬编码。
> 第三方预设只显示 `description` 和「查看配置」；Miloco 的等价说明放在「设置 → 插件 → Miloco → 查看模式说明与用法」。

---

## 6. Bundle 验证

```bash
npm run pack:bundle
tar -tzf dist/dsh-miloco-bridge-0.1.2.tgz | head -30
```

预期包含：`package/lib/*`、`package/skills/*/SKILL.md`、`package/adapter/dsh_adapter.py`、
`package/cordis.patch.yml`、`package/docs/*`，且**不含** `test/`、`node_modules/`、真实 token。

安装：

```bash
DSH_HOME=/tmp/dsh-miloco-bundle-verify \
  dsh plugin --profile web add "file:$PWD/dist/dsh-miloco-bridge-0.1.2.tgz"
```

---

## 7. 已知边界

- 隔离 profile 没有模型 API Key，因此没有在真实 UI 里跑完整 LLM turn；
  推送 turn 的等待/回复逻辑由离线测试覆盖。
- 一键部署会运行上游安装器，耗时取决于网络与 Python 依赖；本次未在干净机器上从零跑完整安装。
- 写操作（控制设备、建任务）没有在真实家庭上执行，避免产生物理副作用；
  写工具的请求体/查询参数已按 OpenAPI 做契约测试（`test/tools-contract.test.js`），
  但真实写入链路仍需在用户确认后用测试任务验证。
