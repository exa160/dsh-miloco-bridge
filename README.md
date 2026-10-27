# dsh-miloco-bridge

**一个把 Xiaomi Miloco 接入 DeepSeek Harness (DSH) 的桥接插件：用专用 Agent 预设隔离 Miloco 产生的工具，避免干扰其他对话/项目，同时兼容 Miloco 的主动推送能力。**

[![npm](https://img.shields.io/npm/v/dsh-miloco-bridge)](https://www.npmjs.com/package/dsh-miloco-bridge)
[![license](https://img.shields.io/github/license/exa160/dsh-miloco-bridge)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)

> 非官方项目，与小米无隶属关系；非网页版，是运行在 DSH Web profile 里的原生插件。
> Miloco 是独立项目，受其自身许可证约束，见 [NOTICE](NOTICE)。

## 截图

| Agent 预设 | Miloco 配置页 |
|---|---|
| ![Agent 预设](https://raw.githubusercontent.com/exa160/dsh-miloco-bridge/main/doc/images/agent-presets.png) | ![Miloco 配置页](https://raw.githubusercontent.com/exa160/dsh-miloco-bridge/main/doc/images/miloco-settings.png) |

> 截图使用演示数据；真实账号、内网地址与 token 用量已脱敏。

## 它解决什么问题

- **Agent 隔离**：53 个 Miloco 工具和 18 个 Skill 只挂在专用预设「Miloco 家庭助手」上。
  普通对话看不到 `miloco_*` 工具，也不会被注入 Miloco 技能。
- **完整能力**：设备、场景、感知、规则、任务、身份、宠物、家庭档案、通知、token 用量。
- **推送闭环**：Miloco 的感知事件、规则触发、任务到期可以主动推送到 DSH 会话。
- **感知过滤**：按 `low / medium / high` 事件优先级过滤，低于阈值的感知建议不产生 DSH turn。
- **可视化配置**：账号/设备/token 概览、推送目标、感知等级、运行模式、连接与卸载都在
  「设置 → 插件 → Miloco」里完成。
- **可独立安装**：没有 Miloco 也能装插件；之后可在 UI 一键部署或连接已有实例。

## 安装

### 从 npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-miloco-bridge
```

### 源码安装（npm 审核期 / 未发布时）

```bash
dsh plugin --profile web add github:exa160/dsh-miloco-bridge
```

### 从 bundle / 本地安装

```bash
# 发布包
dsh plugin --profile web add file:dist/dsh-miloco-bridge-0.1.0.tgz

# 本地开发（link）
./install.sh --profile web
```

### Miloco 侧 adapter

如果已安装 Miloco，`install.sh` 会自动安装 adapter、写入连接与推送令牌。
手动步骤、systemd、升级与卸载见 [doc/INSTALL.md](doc/INSTALL.md)。

安装后重启 DSH：

```bash
systemctl --user restart dsh-web.service
```

## 快速开始

1. 打开 DSH WebUI →「设置 → 插件 → Miloco」。
2. 没有 Miloco：点「一键部署 Miloco」；已有实例：点「连接已有的 Miloco」。
3. 新建会话时选择 **「Miloco 家庭助手」**。
4. 在设置页选择运行模式（只读 / 管家）、推送会话、可选模型与感知等级。
5. 想收 Miloco 主动推送时，确认 Miloco 的 `agent.platform=dsh`，并使用同一枚 Bearer token。

## 权限与风险

- 写入 `$DSH_HOME`（配置、状态、可选部署源码）和 `$MILOCO_HOME`（adapter）。
- 访问 Miloco HTTP API（默认 `127.0.0.1:1810`，也可配置局域网地址）。
- 「一键部署」会运行上游 Miloco 安装器，可能安装 Python 依赖并占用磁盘。
- **默认只读**：写工具不注册；切换到管家模式后才会暴露设备控制、规则/任务创建等能力。
- 插件不包含遥测，不内置任何账号或 token；推送入口无令牌时 fail closed。

## 兼容性

- DSH：`0.2.1-rc.4` 实测通过；建议 `>= 0.2.1-rc.4`。
- Node.js：`>= 22`。
- Miloco：2.0 HTTP API（`/api/*`，`/api/admin/status`、`/api/perception/*` 等）。
- 平台：Linux / macOS；Web profile（`dsh --profile web`）。

## 文档索引

| 文档 | 内容 |
|---|---|
| [doc/INSTALL.md](doc/INSTALL.md) | 安装、连接、adapter、systemd、升级/卸载、排错 |
| [doc/VERIFICATION.md](doc/VERIFICATION.md) | 离线测试、真实 DSH/Miloco 验证、推送与过滤验证 |
| [doc/ARCHITECTURE.md](doc/ARCHITECTURE.md) | 双半架构、路由、配置层、状态文件、推送协议 |
| [doc/SKILL-REWRITES.md](doc/SKILL-REWRITES.md) | 为什么重写 18 个 Skill、改了什么、合规边界 |
| [doc/TOOLS.md](doc/TOOLS.md) | 53 个工具的参数与语义 |
| [SECURITY.md](SECURITY.md) | 安全边界与漏洞报告 |

## 开发

```bash
npm test                 # 50 项测试
npm run selftest         # 离线自检
npm run verify:readonly  # 真实 Miloco 只读接口
npm run pack:bundle      # 生成 dist/*.tgz
./install.sh --check     # 安装环境检查
```

## DSH Plugin 市场信息

- 能力分类：**集成与连接**
- 安装命令：`dsh plugin --profile web add dsh-miloco-bridge`
- GitHub topic：`dsh-plugin`
- 许可证：MIT
- 插件导出：`apply(ctx)`；根目录包含 `package.json`

## 许可证

MIT。Xiaomi Miloco 的名称、接口与商标归小米所有；本仓库不包含上游源码、Skill 原文、
模型或面板资源。详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
