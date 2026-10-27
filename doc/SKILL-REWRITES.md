# 为什么改写 Miloco 的 Skill，以及改了什么

这份文档回答一个问题：**上游 Miloco 已经有 18 个 Skill，为什么本插件还要重写一遍？**

结论先说：上游 Skill 是**给 OpenClaw + `miloco-cli` shell 写的操作规程**；DSH 原生插件
没有 `miloco-cli` 子进程，也没有 OpenClaw 的 IM/cron 运行时。直接照搬会让模型
调用不存在的命令、引用不存在的工具，或者把 openclaw 专属的身份/调度假设带进宿主会话。
另外，上游 Skill 文本受 Xiaomi Miloco 许可证约束，**不适合原样复制进一个 MIT 的 GitHub 仓库**。
因此本仓库的 18 个 Skill 是**按本插件自己的工具契约重新撰写**的，不是上游文本的拷贝。

---

## 1. 上游 Skill 的真实形态

上游 `plugins/skills/*/SKILL.md` 的 frontmatter：

```yaml
name: miloco-devices
description: ...
metadata:
  author: miloco
  version: "1.7"
  openclaw:
    requires:
      bins: ["miloco-cli"]
```

正文是纯 shell 操作规程，例如：

```bash
miloco-cli device list | grep -E '灯|light'
miloco-cli device spec <did>
miloco-cli device control <did> <spec_name> <value>
miloco-cli task delete <task_id> --reason abandoned
```

而本插件把同一批能力做成了 DSH 原生 tools（直接 HTTP，不经子进程）：

```text
miloco_device_list(room?)
miloco_device_spec(did)
miloco_device_control(did, type="set_property", iid, value)
miloco_task_delete(task_id, reason)
```

如果 Skill 仍写 `miloco-cli ...`，模型会尝试执行 shell 命令；而专用预设里没有 shell 工具，
或者宿主设备上根本没有这个二进制，结果就是“看起来会、实际调不动”。

---

## 2. 六个改写原因

### 2.1 执行面：shell 命令 → 原生工具调用

| 上游写法 | DSH 写法 |
|---|---|
| `miloco-cli device list` | `miloco_device_list` |
| `miloco-cli device spec <did>` | `miloco_device_spec(did)` |
| `miloco-cli device control <did> <spec_name> <value>` | `miloco_device_control(did, type="set_property", iid, value)` |
| `miloco-cli device action <did> <spec_name> …` | `miloco_device_control(did, type="call_action", iid, params=[…])` |
| `miloco-cli device props <did>` | `miloco_device_status(did, iid?)` |
| `miloco-cli task delete <id> --reason X` | `miloco_task_delete(task_id, reason)` |
| `miloco-cli home-profile …` | `miloco_home_profile` / `_write` / `_candidate_write` / `_commit` / `_reassign` |

原因：原生工具走 DSH 的工具注册、审批、展示与错误体系；参数是 JSON Schema，模型
不需要拼 shell 引号，也不依赖 PATH。

### 2.2 发现面：frontmatter 与调用时机

上游 frontmatter 的 `metadata.openclaw.requires.bins` 对 DSH 没有意义。DSH 的技能格式
需要 `name`、`description`，并支持 `whenToUse`。改写时：

- 删除 `metadata.openclaw`；
- 新增 `whenToUse`，把“什么时候该加载这个技能”写清楚；
- 保留 `name` 与 `description`，但描述改成面向本插件工具的语义。

本插件通过 `ctx.skills.register()` 在**预设作用域**内注册技能，不写 `~/.dsh/skills/`，
因此普通会话不会收到这些技能。

### 2.3 调度面：OpenClaw managed-cron → DSH/手动触发

上游有 5 个“内部例程”Skill 依赖 OpenClaw 的 managed-cron：

`miloco-home-observe`、`miloco-home-promote`、`miloco-home-prune`、
`miloco-home-patrol`、`miloco-perception-digest`。

在 DSH 里没有 OpenClaw 的调度器。改写后它们变成**可手动触发、也可由 DSH 定时任务触发**
的自包含流程；不再假设某个外部 cron 会注入固定提示词。

### 2.4 安全面：只读模式是“注册层”的

本插件的只读模式不是“注册了再报错”，而是**写工具根本不注册**。因此 Skill 必须：

- 明确说明当前模式可能没有写工具；
- 不能编造调用、不能声称“已执行”；
- 对门锁、燃气、摄像头开关、成员删除等动作要求二次确认；
- 把“查设备/问摄像头/看档案”等只读技能写成在只读模式下也能完成。

### 2.5 人格面：不写死“你是……”

上游测试 `skill-identity.test.ts` 有一条不变量：Skill 正文不得写死 Agent 身份
（`你是……`、`我是 miloco……`），因为 Skill 会加载进宿主 Agent 的上下文，不能覆盖
用户在 DSH 里给自己 Agent 设的人设。

本仓库的 18 个 Skill 全部用“本技能/流程/规则”的叙述，不做身份断言，也不提供
“你好呀，我是 Miloco”这类可被照抄的开场白。

### 2.6 合规面：不复制受限制文本

Xiaomi Miloco 的许可证对复制、修改、分发有明确限制。为了能作为一个 MIT 项目公开：

- 本仓库**不包含**上游源码、Skill 原文、面板资源、模型文件；
- 18 个 Skill 是按本插件自己的工具契约**独立撰写**的；
- `NOTICE` 明确标注非官方、无隶属关系、商标归属；
- “一键部署”只在用户点击后，从官方仓库 clone 并运行上游安装器，不在本仓库分发上游代码。

---

## 3. 18 个 Skill 的映射

| Skill | 主题 | 主要工具 |
|---|---|---|
| `miloco-onboarding` | 首次建立成员与档案 | `miloco_person_create`、`miloco_home_profile_write` |
| `miloco-devices` | 设备查询/控制/场景 | `miloco_device_*`、`miloco_scene_*` |
| `miloco-perception` | 摄像头问答与事件回顾 | `miloco_perceive`、`miloco_perception_logs` |
| `miloco-perception-digest` | 感知日志摘要 | `miloco_perception_logs`、`miloco_event_list` |
| `miloco-create-task` | 规则/定时/统计/生命周期 | `miloco_rule_create`、`miloco_cron_create`、`miloco_task_create` |
| `miloco-terminate-task` | 终止并清理任务 | `miloco_task_delete` |
| `miloco-notify` | 主动通知与文案 | `miloco_notify_push`、`dsh_deliver_message` |
| `miloco-home-profile` | 档案查询与维护 | `miloco_home_profile*` |
| `miloco-home-observe` | 观察并写候选 | `miloco_home_profile_candidate_write` |
| `miloco-home-promote` | 候选提升 | `miloco_home_profile_write(from=…)` |
| `miloco-home-prune` | 去重与主体归一 | `miloco_home_profile_reassign` |
| `miloco-home-patrol` | 家庭巡检 | `miloco_status`、`miloco_*_list` |
| `miloco-habit-suggest` | 习惯洞察 | 档案 + 感知 + 任务清单 |
| `miloco-miot-scope` | 感知范围 | `miloco_perception_scope`、`miloco_scope_set` |
| `miloco-miot-identity` | 成员花名册 CRUD | `miloco_person_*` |
| `miloco-miot-identity-register` | 身份样本预览/落库 | `miloco_register_preview`、`miloco_register_commit` |
| `miloco-miot-pet-register` | 宠物登记 | `miloco_pet_*` |
| `miloco-miot-admin` | 运维与用量 | `miloco_status`、`miloco_token_usage`、`miloco_action_list` |

---

## 4. 上游文档里的接口坑（改写时一并修正）

1. `GET /api/miot/scenes` **不存在**；场景从 `GET /api/miot/home` 的 `scenes` 取。
   → `miloco_scene_list` 直接取 home，不调用不存在的接口。
2. `POST /api/miot/devices/{did}/control` 的 `type` **必填**
   （`set_property` / `set_properties` / `call_action`）。缺少会 422。
3. `iid` 是字符串（`prop.<siid>.<piid>` / `action.<siid>.<aiid>`），不是属性名。
   → Skill 要求先 `miloco_device_spec`，禁止猜 iid。
4. 感知事件里的 `did` 通常是摄像头/传感器，不是控制目标。
5. 家庭档案渲染接口返回 `{markdown: "..."}`，不是 `{rendered: "..."}`。

这些坑在上游 Skill 中有的没有写、有的写成了旧接口；本仓库的 Skill 按真实接口行为编写，
并在 `doc/TOOLS.md` 中保留说明。

---

## 5. 如何验证改写没有“污染”普通对话

1. 起一个**默认预设**的新会话，发一句普通问题；
2. 会话请求头里应有 **0 个** `miloco_*` 工具；
3. 起一个 **Miloco 家庭助手** 预设的新会话；
4. 只读模式应有 **30 个** `miloco_*` 工具；管家模式应有 **53 个**（30 读 + 23 写 + `dsh_deliver_message`）。

如果普通会话出现 `miloco_*`，说明 preset 作用域没生效，检查 `cordis.patch.yml` 中
`preset-miloco` 的 `plugins` 是否指向 `dsh-miloco-bridge/tools`。
