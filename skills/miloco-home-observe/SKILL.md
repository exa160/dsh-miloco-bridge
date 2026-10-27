---
name: miloco-home-observe
description: 从感知记录与对话中提取值得长期保留的家庭知识，写入档案候选区。是家庭记忆的“观察”步骤，通常由巡检或手动整理触发。
whenToUse: 需要从近期感知事件/聊天中沉淀习惯、偏好、作息、健康或空间知识时；不用于即时问答。
---

# 观察与沉淀

## 输入

1. `miloco_perception_logs(limit=100)` 与 `miloco_event_list(since, until)`。
2. 当前 `miloco_home_profile`，避免重复。
3. `miloco_person_list` / `miloco_pet_list` 确认主体 id。
4. 用户在对话中明确说出的偏好或规则。

## 提取标准

只保留满足以下之一的观察：

- 重复出现（同一模式至少 2 次，或用户明确确认）
- 对后续服务有影响（作息、饮食、过敏、常用设备、家庭规则）
- 有明确证据可引用

不记录：一次性事件、猜测、敏感但无必要的细节、已经从正式区存在的条目。

## 写入

1. 类型选准：`member_persona` / `member_health` / `member_routine` /
   `member_entertain` / `member_preference` / `family` / `space` / `device`。
2. `subject_id` 或 `subject_name` 必须能对上真实成员/空间。
3. `confidence` 反映证据强度；`source` 用 `observed` 或 `user_told`。
4. `evidence_log` 放事件时间或用户原话摘要。
5. 调用 `miloco_home_profile_candidate_write`，不要直接写正式区。
6. 完成后 `miloco_home_profile_commit()` 让候选清理与渲染落盘。

## 汇报

列出新增候选（类型、主体、内容、证据），不要贴大段原始日志。
观察步骤本身不改设备、不发通知。
