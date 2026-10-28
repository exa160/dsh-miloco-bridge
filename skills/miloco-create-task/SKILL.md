---
name: miloco-create-task
description: 把一句家庭需求装配成可长期运转的任务：先建任务占位行，再按需挂规则、定时提醒、累计统计或限时生命周期，并在创建后自检。适用于“每天提醒我…”“当…就…”“记录他每天…”“先试一周”。
whenToUse: 用户提出持续性的提醒、自动化、习惯记录或有时限的家庭任务时。
---

# 创建家庭任务

## 任务由多个构件组成

新版 Miloco 的 `POST /api/tasks` 只创建任务占位行（`task_id` + `description`），
规则、定时、统计都要另外挂到同一个 `task_id` 上。

| 构件 | 回答的问题 | 工具 |
|---|---|---|
| task | 任务叫什么、活多久 | `miloco_task_create` |
| rule | 当 X 时做 Y | `miloco_rule_create` |
| schedule | 什么时候提醒 | `miloco_cron_create` |
| record | 累计什么、达到什么算完成 | `miloco_task_record_init` |

不要再用旧参数 `kind=rule/schedule/record` 调 `miloco_task_create`，后端不接受。

## 前置检查

1. `miloco_perception_devices`：规则里的摄像头必须正在感知。
2. `miloco_person_list`：涉及具体家人时先拿 person_id，不用名字硬拼。
3. `miloco_task_list` + `miloco_rule_list` + `miloco_cron_list`：先查重，已有就调整而不是重复建。
4. `miloco_device_list` + `miloco_device_spec`：动作必须落到真实 did 与真实 iid。

## 装配顺序

### 1. 先建任务

```text
miloco_task_create(
  task_id="living_room_tidy",        # 只能用小写字母、数字、下划线，≤32 位
  description="整理客厅杂物，保持通道畅通"  # ≤200 字
)
```

限时任务再加 `lifecycle="temporary"` 与带时区的 `expires_at`。

### 2. 按需挂构件

**定时提醒**：`miloco_cron_create` 必须带 `task_id`。

```text
miloco_cron_create(
  name="每天整理客厅",
  kind="cron",
  cron_expr="0 20 * * *",
  message="花十分钟整理客厅茶几和沙发旁的杂物",
  task_id="living_room_tidy"
)
```

**条件规则**：`miloco_rule_create` 的 `condition` 必须给感知设备 did 列表和自然语言条件；
`event` 模式用 `actions`（设备直控）或 `action_descriptions`（Agent 回调）。

```text
miloco_rule_create(
  name="客厅有人开灯",
  task_id="living_room_presence",
  condition={ perceive_device_ids=["camera_did"], query="客厅有人活动" },
  mode="event",
  actions=[{ did="light_did", iid="prop.2.1", value=true }]
)
```

**累计统计**：`miloco_task_record_init` 的 `kind` 只能是 `progress / duration / event`。

```text
miloco_task_record_init(
  task_id="drink_water",
  kind="progress",
  content={ target=8, unit="杯", window="day" }
)
```

- `progress`：`target`、`unit`、`window`（`day/week/month/longterm`）必填
- `duration`：`target_minutes` 可选
- `event`：`content` 可为空

## 自检

创建后重新读取：

- `miloco_task_list` / `miloco_rule_list` / `miloco_cron_list`
- 确认名称、触发条件、动作、启用状态、关联 task_id 都符合预期
- 失败时报告后端原文，不要声称“已创建”

## 安全

- 写工具仅在管家模式注册；只读模式应说明无法创建。
- 规则涉及门锁、燃气、摄像头关闭等高风险动作时，先向用户确认。
- 不要创建会无限循环触发自身动作的规则。
