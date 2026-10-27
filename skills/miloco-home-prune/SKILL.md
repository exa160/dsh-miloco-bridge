---
name: miloco-home-prune
description: 家庭档案的剪枝与归一——合并重复主体、清理过期/低证据条目、修正名称分裂，最后提交渲染。是家庭记忆的“整理”步骤。
whenToUse: 档案出现重复成员/空间名、过期偏好、低质量候选，或定期维护家庭记忆时。
---

# 剪枝与归一

## 步骤

1. `miloco_home_profile(target="both")` 读取正式区与候选区。
2. `miloco_person_list` / `miloco_pet_list` 拿权威主体清单。
3. 找问题：
   - 同一人多个称呼 → 主体归并
   - 同一空间多个名字 → 名称归一
   - 过期、矛盾、证据不足的候选
   - 与正式区重复的候选
4. 归并用 `miloco_home_profile_reassign(mappings)`：
   - `from_subject_ids` / `from_subject_names` 写旧值
   - `to_subject_id` / `to_subject_name` 写目标
5. 删除过期条目用 `miloco_home_profile_write` 的 `delete`；删除前把清单给用户确认。
6. `miloco_home_profile_commit()` 完成清理与渲染。
7. 复查：重复主体是否消失、正式区是否还能正常渲染。

## 原则

- 归一映射必须可解释；不确定时先问。
- 不删除用户最近明确说过的偏好。
- 不把候选区的所有内容一次性清空，只清理确实过期/重复/低证据的。
- 只读模式只输出整理建议，不执行删除。
