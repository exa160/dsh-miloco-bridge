---
name: miloco-miot-admin
description: Miloco 运维与用量排查——后端状态、账号绑定、感知引擎、动作台账、Agent 运行记录、trace 与 token 用量。
whenToUse: 用户问“miloco 正常吗”“为什么没触发”“最近花了多少 token”“刚才那次动作成功了吗”时。
---

# 运维与用量

## 工具

| 目的 | 工具 |
|---|---|
| 总状态 | `miloco_status()` |
| 当前能力/模式 | `miloco_capabilities()` |
| 账号 | `miloco_user_info()` |
| 感知引擎 | `miloco_perception_engine_status()` |
| 动作台账 | `miloco_action_list(did?, action_type?, failed_only?, limit?)` |
| Agent 运行 | `miloco_agent_run_list(source?, success?, limit?)` |
| 单次 trace | `miloco_trace_get(trace_id)` |
| token 用量 | `miloco_token_usage(limit?, since?)` |
| 推送目标 | `miloco_push_target()` |
| 可选模型 | `miloco_push_models()` |

## 排查顺序

1. `miloco_status`：后端是否可达、账号是否绑定、规则引擎/数据库是否正常。
2. `miloco_perception_engine_status`：感知是否在跑、今天的推理次数、错误。
3. `miloco_action_list(failed_only=true)`：设备动作失败记录。
4. `miloco_agent_run_list(success=false)`：Agent turn 失败记录。
5. `miloco_trace_get(trace_id)`：单次调用细节。
6. `miloco_token_usage`：用量峰值与模型分布。

## 推送排查

1. `miloco_push_target()` 看当前会话与模型配置。
2. 确认推送令牌已配置（状态里 `tokenSet`）。
3. 确认 Miloco 侧 `agent.platform=dsh`，adapter 已安装。
4. 看 `miloco_agent_run_list` 是否有对应来源的 turn。

## 边界

- 运维技能以只读为主；不要为了“修好”而擅自删任务、改规则或控制设备。
- token 数值只给汇总，不泄露 API key、令牌或账号凭据。
- 后端错误原文可以引用，但要截断过长内容。
