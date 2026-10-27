---
name: miloco-miot-identity-register
description: 给家庭成员登记识别样本——上传图片/视频做候选预览，用户确认后落库。适用于“让系统认识我”“把这个人登记成爸爸”“从陌生人记录里建档”。
whenToUse: 用户提供照片/视频并指明某人的身份，或要求把感知到的陌生人加入家庭成员时。
---

# 身份样本登记

## 工具

| 步骤 | 工具 |
|---|---|
| 预览候选（不落库） | `miloco_register_preview(...)` |
| 正式落库（写） | `miloco_register_commit(...)` |
| 已有成员补样本 | `miloco_register_preview(member_id=…)` |
| 先建花名册 | `miloco_person_create(name, role?)` |

## 流程

1. `miloco_person_list` 查是否已有该成员。
2. 用户提供媒体后，把媒体内容以 base64 传给 `miloco_register_preview`：
   - 单张图：`media_b64` + `media_kind="image"`
   - 多张图：`media_b64_list`
   - 视频：`media_b64` + `media_kind="video"`
3. 把预览返回的候选（索引、置信度、外观描述）展示给用户，让其选择。
4. 用户确认后调用 `miloco_register_commit`：
   - `register_session_id_pending` 用预览返回值
   - `indices` 用选中的候选索引
   - 新成员可同时给 `member_name` / `member_role`
5. 复查 `miloco_person_list` 的样本数量。

## 必须遵守

- **没有用户确认，不落库。**
- 不把未经允许的家人照片用于登记。
- 预览失败时报告后端原文，不伪造候选。
- 删除样本属于成员删除，走 `miloco_person_delete` 并二次确认。
- 只读模式没有预览/落库写工具；此时只说明需要管家模式。
