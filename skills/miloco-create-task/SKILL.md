---
name: miloco-create-task
description: 把一句家庭需求装配成可长期运转的任务：条件规则、定时提醒、行为累积统计、限时生命周期，并在创建后自检。适用于“每天提醒我…”“当…就…”“记录他每天…”“先试一周”。
whenToUse: 用户提出持续性的提醒、自动化、习惯记录或有时限的家庭任务时。
---

# 创建家庭任务

## 四类构件

| 构件 | 回答的问题 | 工具 |
|---|---|---|
| rule | 当 X 时做 Y | `miloco_rule_create` / `miloco_rule_list` |
| schedule | 什么时候提醒 | `miloco_cron_create` / `miloco_cron_list` |
| record | 累计什么、达到什么算完成 | `miloco_task_create(kind="record")` |
| lifecycle | 任务活多久 | `miloco_task_create(kind="lifecycle")` |

一个需求可以由多个构件组成，不要硬塞进单一类型。

## 前置检查

1. `miloco_perception_devices`：规则里的摄像头必须正在感知。
2. `miloco_person_list`：涉及具体家人时先拿 person_id，不用名字硬拼。
3. `miloco_task_list` + `miloco_rule_list` + `miloco_cron_list`：先查重，已有就调整而不是重复建。
4. `miloco_device_list` + `miloco_device_spec`：动作必须落到真实 did 与真实 iid。

## 装配

1. **rule**：`content` 用“当…时…”的自然语言，`mode` 选 `event` 或 `state`。需要多个动作时写清楚顺序。
2. **schedule**：`miloco_cron_create` 支持 `cron_expr` / `at_iso` / `every_ms`；`message` 是到点投递给 Agent 的文本，要能独立看懂。
3. **record**：`miloco_task_create(kind="record", content=…)`，内容写清统计对象、计数方式、达标条件。
4. **lifecycle**：`miloco_task_create(kind="lifecycle", content=…)`，写明开始/结束条件或期限。
5. 用 `task_id` 把 schedule 关联到长期任务。

## 自检

创建后重新读取：

- `miloco_rule_list` / `miloco_task_list` / `miloco_cron_list`
- 确认名称、触发条件、动作、启用状态、关联 task_id 都符合预期
- 失败时报告后端原文，不要声称“已创建”

## 安全

- 写工具仅在管家模式注册；只读模式应说明无法创建。
- 规则涉及门锁、燃气、摄像头关闭等高风险动作时，先向用户确认。
- 不要创建会无限循环触发自身动作的规则。
