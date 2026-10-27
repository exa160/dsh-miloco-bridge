---
name: miloco-terminate-task
description: 终止长期任务——用户主动取消，或任务完成/过期时，删除任务并清理关联规则、定时计划与统计记录。删除前必须确认。
whenToUse: 用户说“取消这个任务”“不用提醒了”“任务做完了/到期了”，或需要清理失效任务时。
---

# 终止任务

## 流程

1. `miloco_task_list` / `miloco_task_summary` 找到目标任务（名称可能重复，用 id 确认）。
2. 读取 `miloco_cron_list(task_id=…)` 与 `miloco_rule_list`，列出将被一并清理的计划与规则。
3. **用户主动取消**：先复述任务名、关联计划、不可恢复，得到明确确认。
4. `miloco_task_delete(task_id, reason)`：
   - `completed` 正常完成
   - `expired` 到期
   - `abandoned` 用户放弃/取消
5. 再查 `miloco_task_list` 与 `miloco_cron_list`，确认已消失；有残留就报告。

## 自动触发

任务因完成或到期需要收尾时，可以直接用 `completed` / `expired`，不需要额外确认；仍然要报告删除了什么。

## 边界

- 只读模式没有 `miloco_task_delete`；不要假装已删除。
- 删除任务会影响历史统计记录，确认时说明这一点。
- 不要删除与本任务无关的规则或计划。
