---
name: miloco-home-profile
description: 家庭档案的查询与维护——记录家人的偏好、习惯、作息、健康、家庭规则与空间/设备知识；也处理修正、删除、合并与查询。
whenToUse: 用户提到自己或家人的喜好、习惯、身体状况、作息、家庭规矩，或要求查看/修改家庭记忆时；即使没有明说“记录”也应考虑。
---

# 家庭档案

## 工具

| 目的 | 工具 |
|---|---|
| 读取正式区 + 渲染文本 | `miloco_home_profile(target?)` |
| 写正式区 | `miloco_home_profile_write(ops)` |
| 写候选区 | `miloco_home_profile_candidate_write(ops)` |
| 提交/清理/渲染 | `miloco_home_profile_commit()` |
| 统一主体 | `miloco_home_profile_reassign(mappings)` |

## 条目类型

`member_persona` / `member_health` / `member_routine` / `member_entertain` / `member_preference` / `family` / `space` / `device`

## 写入原则

1. **先查再写**：`miloco_home_profile` 看已有条目，避免重复和矛盾。
2. **用户明确说的** → `source="user_told"`，可直接写正式区。
3. **Agent 观察到的** → 先写候选区；证据不足时不要提升。
4. **不确定** → 先问一句，不把猜测写成事实。
5. 健康、过敏、用药等敏感信息只在必要时记录，并保持原话。
6. 修正旧记录时用 `update`/`replace` 并保留 `id`；删除用 `delete`，删除前确认。

## 候选与提升

- 候选写 `miloco_home_profile_candidate_write`，`evidence_log` 写明来源（感知事件、用户原话）。
- 提升时用 `miloco_home_profile_write` 的 `from=<candidate_id>`，后端会消费该候选。
- 定期 `miloco_home_profile_commit` 让过期候选清理、预算归档与 markdown 渲染落盘。

## 主体归并

同一人的“爸爸/父亲/老王”或同一空间的“客厅/大厅/起居室”用
`miloco_home_profile_reassign` 收敛，避免档案分裂。归并前把映射关系给用户看。

## 只读模式

只读模式仍有 `miloco_home_profile`，可以回答“他喜欢什么”“家里有什么规矩”；
所有写入工具都不会注册。
