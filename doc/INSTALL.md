# 安装与配置

## 0. 前置条件

- Node.js ≥ 22
- 可用的 DSH（本项目在 `0.2.1-rc.4` 上验证）
- 可选：已安装或准备安装 Xiaomi Miloco
- 可选：`git`、`python3`（一键部署与 adapter 语法检查）

插件本身**不要求** Miloco 已安装。

---

## 1. 三种安装方式

### 1.1 本地 link（开发）

```bash
cd /path/to/dsh-miloco-bridge
./install.sh --profile web
```

等价于：

```bash
dsh plugin --profile web add "link:/path/to/dsh-miloco-bridge"
```

npm 新包可能处于审核期；若 `dsh plugin add dsh-miloco-bridge` 暂时 404，
可改用 `dsh plugin --profile web add github:exa160/dsh-miloco-bridge`。

### 1.2 打包后安装（发布）

```bash
npm run pack:bundle
# dist/dsh-miloco-bridge-0.1.0.tgz
dsh plugin --profile web add "file:/path/to/dist/dsh-miloco-bridge-0.1.0.tgz"
```

或：

```bash
./install.sh --profile web --bundle dist/dsh-miloco-bridge-0.1.0.tgz
```

### 1.3 手动配置

如果不用 `dsh plugin`，至少要让 profile 的 `package.json` 包含：

```json
{
  "dependencies": { "dsh-miloco-bridge": "link:/path/to/repo" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-miloco-bridge"] } }
}
```

---

## 2. install.sh 做了什么

```text
install.sh
├── 1. 安装插件（link: 或 file:tgz）
├── 2. 检测 $MILOCO_HOME/config.json
│    ├── 已安装
│    │   ├── 写 $DSH_HOME/miloco-plugin.json（连接 + 推送令牌，0600）
│    │   ├── 安装 adapter 到 $MILOCO_HOME/agent_platform/dsh/
│    │   ├── 写 adapter config.yaml
│    │   └── 尝试 miloco-cli config set agent.platform dsh
│    └── 未安装
│        └── 只装插件，提示到 WebUI 一键部署/连接
└── 3. 离线自检 + webhook 探活
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--profile <name>` | DSH profile，默认 `$DSH_PROFILE` 或 `web` |
| `--miloco-home <dir>` | Miloco home，默认 `$MILOCO_HOME` 或 `~/.miloco` |
| `--dsh-origin <url>` | DSH Web 地址，写入 adapter 的 `webhook_url` |
| `--token <token>` | 推送/agent 令牌；不填则复用 Miloco 现有 token 或随机生成 |
| `--bundle <tgz>` | 从打包文件安装 |
| `--no-adapter` | 不安装 Miloco 侧 adapter |
| `--no-connect` | 只装插件，不写连接/令牌 |
| `--check` | 只做离线检查 |

---

## 3. 未安装 Miloco：一键部署

1. 安装并重启 DSH；
2. 打开「设置 → 插件 → Miloco」；
3. 点「一键部署 Miloco」；
4. 面板会实时显示部署日志。流程：
   - 若检测到已安装的 `miloco-cli` 与 `$MILOCO_HOME/config.json`，先尝试 `service start`；
   - 否则 clone `https://github.com/XiaoMi/xiaomi-miloco` 到
     `$DSH_HOME/plugin-data/dsh-miloco-bridge/xiaomi-miloco`；
   - 运行上游 `scripts/install.sh --dev --skip-openclaw`；
   - 启动后端并等待 `127.0.0.1:1810` 健康；
   - 安装本插件的 adapter，生成/复用推送令牌，写入 overlay。
5. 部署完成后按面板提示绑定米家账号、开启摄像头感知。

> **部署目录必须可写**：默认是 `$DSH_HOME/plugin-data/dsh-miloco-bridge/xiaomi-miloco`
> （`$DSH_HOME` 默认 `~/.dsh`，跟随环境变量）。不要指向只读工作区、`node_modules`
> 或其它 DSH 进程用户不可写的路径；部署前会显式检查并给出中文错误。

> 一键部署会运行上游安装器，可能安装 Python 依赖并占用较多磁盘。
> 请先确认你接受 Xiaomi Miloco 的许可证与资源开销。

---

## 4. 已安装 Miloco：连接

### 4.1 WebUI

「设置 → 插件 → Miloco」→「连接已有的 Miloco」：

- `baseUrl`：例如 `http://192.0.2.10:1810`
- `token`：`$MILOCO_HOME/config.json` 的 `server.token`（如果后端未启用鉴权可留空）
- `pushToken`：留空则使用上面的 token；也可单独指定

保存后：

- 写 `$DSH_HOME/miloco-plugin.json` 的 `connection` 与 `push.token`；
- 两个半边都立即读到新连接，**不需要重启 DSH**；
- 若配置了 `profilePatch`，会尽力把 `baseUrl`/`token` 写回 profile。

### 4.2 CLI

```bash
./install.sh --profile web \
  --miloco-home ~/.miloco \
  --dsh-origin http://192.0.2.10:3080 \
  --token '<与 Miloco agent.auth_bearer 一致>'
```

### 4.3 Miloco 侧 adaper

`install.sh` 会做这些事；手动等价操作：

```bash
mkdir -p "$MILOCO_HOME/agent_platform/dsh"
cp adapter/dsh_adapter.py "$MILOCO_HOME/agent_platform/dsh/adapter.py"

cat > "$MILOCO_HOME/agent_platform/dsh/config.yaml" <<'YAML'
webhook_url: "http://192.0.2.10:3080/miloco/webhook"
auth_bearer: "<与插件 push.token 一致>"
include_home_profile: true
home_profile_max_chars: 4000
YAML

miloco-cli config set agent.platform dsh
miloco-cli config set agent.webhook_url "http://192.0.2.10:3080/miloco/webhook"
miloco-cli config set agent.auth_bearer "<与插件 push.token 一致>"
miloco-cli service restart
```

adapter 是 duck-typed 的，只要求 `name` / `send_turn` / `read_trace_meta`；
它与 `config.yaml` 权限应为 `0600`。

---

## 5. 配置层次

| 层 | 位置 | 作用 |
|---|---|---|
| bundle 默认 | `node_modules/dsh-miloco-bridge/cordis.patch.yml` | 工具/预设/推送默认值 |
| profile 覆盖 | `$DSH_HOME/profiles/<profile>/cordis.patch.yml` | 用户级静态覆盖 |
| 运行时 overlay | `$DSH_HOME/miloco-plugin.json` | 连接、推送令牌、推送目标；立即生效 |
| 共享状态 | `$DSH_HOME/miloco-plugin.state.json` | 运行模式、最近触发 Miloco 的会话 |

`$DSH_HOME` 默认 `~/.dsh`；设置环境变量后会跟随。

overlay 示例：

```json
{
  "connection": { "baseUrl": "http://192.0.2.10:1810", "token": "…" },
  "push": {
    "token": "…",
    "target": { "sessionId": "" },
    "model": { "provider": "", "model": "", "reasoningEffort": "" },
    "perception": { "minLevel": "all" }
  }
}
```

- `target.sessionId` 空 = 上一次触发 Miloco 的会话；
- `model` 空 = 跟随该对话；
- `perception.minLevel` = `all` / `low` / `medium` / `high`，低于该等级的感知建议不投递；
- `push.token` 与 Miloco 的 `agent.auth_bearer` 必须一致。

---

## 6. 运行模式

「设置 → 插件 → Miloco → 运行模式」：

| 模式 | 工具 |
|---|---|
| `readonly` | 30 个只读工具 + 18 技能 |
| `full` | 30 只读 + 23 写 + `dsh_deliver_message` + 18 技能 |

模式写在状态文件里，**插件激活时读取**：

```bash
systemctl --user restart dsh-web.service
# 或重新挂载该预设
```

已有会话保留创建时拿到的工具集；切换模式后建议新建会话。

---

## 7. systemd（可选）

若 DSH 是手工启动的，崩溃后不会自动恢复。示例单元：

```ini
[Unit]
Description=DeepSeek Harness Web
After=network.target

[Service]
Type=simple
WorkingDirectory=%h
ExecStart=/home/you/.npm-global/bin/dsh web --no-open
Restart=always
RestartSec=5
Environment=HOME=/home/you

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now dsh-web.service
systemctl --user restart dsh-web.service
```

> 重启 DSH 会中断正在跑的会话。把“停 + 起”放在一条命令里。

---

## 8. 升级 / 卸载

### 8.1 卸载 Miloco（保留 DSH 插件）

「设置 → 插件 → Miloco → 运行状态 → 卸载 Miloco」：

1. 输入 `UNINSTALL` 确认；
2. 可选勾选：
   - **删除源码目录**：仅允许 `$DSH_HOME/plugin-data/dsh-miloco-bridge` 或旧的 `$DSH_HOME/miloco-deploy` 下的路径；
   - **删除 Miloco 数据目录**：仅允许 `~/.miloco` 或 `~/.openclaw/miloco`，会删除账号绑定、数据库、感知记录，不可恢复；
3. 执行后会停止 `miloco.service`（或 supervisor）、移除 adapter、清空插件的连接与推送令牌。

自定义 `MILOCO_HOME` / `deploy.sourceDir` 不会被自动删除，接口会拒绝并提示手动处理，避免误删。

### 8.2 卸载 DSH 插件

升级 link 安装：

```bash
cd /path/to/dsh-miloco-bridge
git pull
systemctl --user restart dsh-web.service
```

升级 bundle：

```bash
npm run pack:bundle
dsh plugin --profile web add "file:dist/dsh-miloco-bridge-0.1.0.tgz"
systemctl --user restart dsh-web.service
```

卸载插件：

```bash
dsh plugin --profile web remove dsh-miloco-bridge
# 可选：删除运行时文件
rm -f "$DSH_HOME/miloco-plugin.json" "$DSH_HOME/miloco-plugin.state.json"
# 可选：删除 Miloco 侧 adapter
rm -rf "$MILOCO_HOME/agent_platform/dsh"
```

---

## 9. 排错

| 现象 | 检查 |
|---|---|
| 设置页 404 | 插件是否在 profile `bundles` 里；重启 DSH |
| 后端连不上 | `$MILOCO_HOME/config.json` 的 `server.url`；或 WebUI 里手动连接 |
| webhook 503 | 推送令牌为空（fail closed）；在 WebUI 连接时填 `pushToken` |
| webhook 401 | DSH 与 Miloco 的令牌不一致 |
| 普通会话也有 miloco 工具 | 预设未生效；检查 `preset-miloco.plugins` |
| 推送落到了错误会话 | 清空 `target.sessionId` 用“上一次触发”，或显式选择会话 |
| 模型没跟随对话 | 检查 overlay 里是否残留 provider/model |
| `~` 路径读不到 | 升级到包含 `lib/paths.js` 的版本；路径会按 `$DSH_HOME` 展开 |
| Miloco 首页 404、但 `/api/*` 仍响应 | 后端进程可能还挂在旧源码路径（静态目录随源码移动而失效）。用 `supervisorctl reread/update` 重载配置后重启；若报 `No module named miloco`，检查 venv 的 editable `.pth` 是否仍指向旧路径 |
