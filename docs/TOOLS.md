# 工具参考

所有米家工具返回 JSON 字符串。工具只在「Miloco 家庭助手」预设的会话中可见。

- 只读模式：30 个只读工具
- 管家模式：30 只读 + 26 写
- 另有 `dsh_deliver_message`（DSH 侧投递，不碰设备）

## 只读工具（30）

| 工具 | 参数 | 后端接口 | 说明 |
|---|---|---|---|
| `miloco_status` | — | `/api/admin/status` + `/api/perception/engine/status` | 运行状态、账号、引擎、数据库 |
| `miloco_capabilities` | — | — | 当前模式与已注册工具 |
| `miloco_device_list` | `room?`, `name?`, `online_only?`, `limit?`, `offset?`, `include?[]` | `/api/miot/device_list` | 默认 `did/name/online/room_name/model/home_id`，默认最多 500 台；`include` 可取 `icon/local_ip/home_name/order_time/lan_online/sub_devices` |
| `miloco_device_spec` | `did` | `/api/miot/devices/{did}/spec` | SPEC：iid、access、枚举、范围 |
| `miloco_device_status` | `did`, `iid?` | `/api/miot/devices/{did}/status` | 当前属性值 |
| `miloco_device_history` | — | `/api/miot/device_history` | 最近访问的 iid |
| `miloco_home_info` | `refresh?` | `/api/miot/home` | 设备 + 区域 + 场景 + 成员 |
| `miloco_camera_list` | — | `/api/miot/camera_list` | 摄像头清单 |
| `miloco_user_info` | — | `/api/miot/user_info` + `/login_status` | 账号与登录状态 |
| `miloco_scene_list` | — | `/api/miot/home` | 场景从 home 的 `scenes` 取 |
| `miloco_perceive` | `sources[]`, `query` | `/api/perception/perceive` | 问画面/声音 |
| `miloco_perception_logs` | `limit?`, `since?` | `/api/perception/logs` | 近期感知事件 |
| `miloco_perception_devices` | — | `/api/perception/devices` | 正在感知的摄像头 |
| `miloco_perception_scope` | — | `/api/miot/scope/cameras` | 感知范围、麦克风、须知 |
| `miloco_perception_engine_status` | — | `/api/perception/engine/status` | 引擎细节 |
| `miloco_event_list` | `event_type?`, `source?`, `since?`, `until?`, `limit?` | `/api/events` | 原始事件流 |
| `miloco_rule_list` | `enabled_only?`, `include_milestone?` | `/api/rules` | 自动化规则 |
| `miloco_rule_logs` | `rule_id?` | `/api/rules/logs` | 规则触发日志 |
| `miloco_task_list` | — | `/api/tasks` | 长期任务 |
| `miloco_task_summary` | — | `/api/tasks/summary` | 任务汇总 |
| `miloco_cron_list` | `task_id?`, `orphan?` | `/api/crons` | 定时计划 |
| `miloco_person_list` | — | `/api/identity/persons` | 家庭成员 |
| `miloco_pet_list` | — | `/api/identity/pets` | 宠物 |
| `miloco_home_profile` | `target?` | `/api/home-profile/entries` + `/rendered` | 家庭档案 |
| `miloco_token_usage` | `limit?`, `since?` | `/api/admin/token-usage` | token 用量 |
| `miloco_action_list` | `did?`, `action_type?`, `failed_only?`, `limit?` | `/api/actions` | 设备动作台账 |
| `miloco_agent_run_list` | `source?`, `success?`, `limit?` | `/api/agent_runs` | Agent 运行记录 |
| `miloco_trace_get` | `trace_id` | `/api/trace/{trace_id}` | 单次 trace |
| `miloco_push_target` | — | overlay | 当前推送目标与感知等级 |
| `miloco_push_models` | — | DSH 模型目录 | 可选模型清单 |

## 写工具（26，仅管家模式）

| 工具 | 参数 | 说明 |
|---|---|---|
| `miloco_device_control` | `did`, `type?`, `iid?`, `value?`, `properties?[]`, `params?[]` | `set_property`（默认）/ `set_properties` / `call_action` |
| `miloco_scene_trigger` | `scene_id` | 触发手动场景 |
| `miloco_notify_push` | `notify` | 米家 App 通知 |
| `miloco_rule_create` | `name`, `task_id`, `condition`, `mode?`, `direction?`, `actions?[]`, `action_descriptions?[]`, `on_enter_*?`, `on_exit_*?` | 创建结构化规则；不再接收自然语言 `content` |
| `miloco_rule_delete` | `rule_id` | 删除规则 |
| `miloco_task_create` | `task_id`, `description`, `lifecycle?`, `expires_at?` | 创建任务占位行；`task_id` 只能用小写字母/数字/下划线 |
| `miloco_task_record_init` | `task_id`, `kind`, `content?` | 初始化累计记录：`progress` / `duration` / `event` |
| `miloco_task_delete` | `task_id`, `reason` | 删除任务（`completed` / `expired` / `abandoned`） |
| `miloco_cron_create` | `kind`, `message`, `name?`, `cron_expr?`, `at_iso?`, `every_ms?`, `tz?`, `task_id?` | 注册定时计划；`every_ms` 最小 60000 |
| `miloco_cron_delete` | `cron_id` | 删除定时计划 |
| `miloco_scope_set` | `items[]{did, in_use}` | 修改感知摄像头 |
| `miloco_home_profile_write` | `ops[]`, `user_edit?` | 写正式档案；`from=<candidate_id>` 消费候选 |
| `miloco_home_profile_candidate_write` | `ops[]` | 写候选档案；每个 op 必须带 `date` |
| `miloco_home_profile_commit` | — | 清理/归档/渲染（无请求体） |
| `miloco_home_profile_reassign` | `mappings[]` | 主体归并/名称归一 |
| `miloco_person_create` | `name`, `role?` | 新增成员花名册 |
| `miloco_person_update` | `person_id`, `name?`, `role?` | 修改成员 |
| `miloco_person_delete` | `person_id` | 删除成员及样本 |
| `miloco_pet_create` | `name`, `species?` | 新增宠物 |
| `miloco_pet_update` | `pet_id`, `name?`, `species?` | 修改宠物 |
| `miloco_pet_delete` | `pet_id` | 删除宠物 |
| `miloco_pet_observe` | `files[]`, `grounding?` | 观察宠物外观（不落库） |
| `miloco_pet_reference_crops` | `pet_id`, `files[]`, `mode?` | 落库参照图；multipart 字段为 `crops` |
| `miloco_register_preview` | `media_b64?`, `media_b64_list?`, `media_kind?`, `cluster_id?`, `member_id?`, `topk?` | 身份样本预览 |
| `miloco_register_commit` | `register_session_id_pending`, `indices?`, `member_name?`, `member_role?` | 身份样本落库 |
| `miloco_push_target_set` | `sessionId?`, `provider?`, `model?`, `reasoningEffort?`, `perceptionLevel?` | 修改推送目标与感知等级 |

## DSH 侧工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `dsh_deliver_message` | `text`, `sessionId?`, `name?`, `provider?`, `model?`, `reasoningEffort?` | 投递文本到 DSH 会话；模型留空跟随会话 |

## 关键约定

- `iid` 是字符串：`prop.<siid>.<piid>`（属性）/ `action.<siid>.<aiid>`（动作）。
- 控制前必须 `miloco_device_spec`，不猜 iid、不套默认枚举。
- `call_action` 的 `params` 只传值，按 spec 顺序。
- 感知事件里的 `did` 通常是来源摄像头，不是控制目标。
- `miloco_perceive` 只回答画面/声音；温度、电量用 `miloco_device_status`。
- 门锁、燃气、摄像头开关、成员/宠物删除、感知范围修改需要二次确认。
- 只读模式下写工具**不存在**，不要编造调用。
