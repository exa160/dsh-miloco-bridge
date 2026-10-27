---
name: miloco-home-patrol
description: 家庭巡检——一次性检查账号、设备在线、感知引擎、规则/任务、档案与用量，输出有优先级的异常清单。可由 DSH 定时任务或用户手动触发。
whenToUse: 用户说“巡检一下家里”“看看有没有异常”“检查 miloco 状态”，或定时巡检任务触发时。
---

# 家庭巡检

## 检查项

1. `miloco_status`：后端、米家账号、规则引擎、数据库。
2. `miloco_user_info`：账号是否绑定、昵称是否可读。
3. `miloco_device_list`：设备总数、离线设备、异常状态（按后端返回字段判断）。
4. `miloco_camera_list` + `miloco_perception_devices`：摄像头在线与感知开启情况。
5. `miloco_perception_engine_status`：引擎是否运行、错误信息、今日推理次数。
6. `miloco_rule_list` + `miloco_task_list`：启用/停用、即将到期、失败任务。
7. `miloco_home_profile`：档案是否为空、是否有明显重复主体。
8. `miloco_token_usage(limit=20)`：近期用量与异常峰值。

## 输出

```
# 巡检结果

## 需要处理
- [高] …
- [中] …

## 正常
- …

## 建议
- …
```

按“影响安全/隐私 > 影响自动化 > 影响体验 > 仅信息”排序。

## 边界

- 默认只读，不自动修设备、不改规则、不删除任务。
- 用户明确要求修复时，再调用对应写工具，并逐项确认。
- 不把 token 数值、账号 uid 等敏感信息发到无关会话。
- 巡检报告可投递到当前会话；需要发到别处时用 `dsh_deliver_message`。
