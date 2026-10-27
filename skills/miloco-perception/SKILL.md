---
name: miloco-perception
description: 通过摄像头看画面、听声音，并回顾近期感知事件，回答“现在/刚才家里发生了什么”。适合人物、动作、声音、画面核实这类问题；温度、电量等数值不要用它。
whenToUse: 用户问“客厅有人吗”“刚才谁进门”“孩子在干嘛”“有没有异响”“摄像头里灯关了吗”等画面/声音问题时。
---

# 摄像头感知

## 工具

| 目的 | 工具 |
|---|---|
| 问画面/声音 | `miloco_perceive(sources[], query)` |
| 近期感知事件 | `miloco_perception_logs(limit?, since?)` |
| 正在感知的摄像头 | `miloco_perception_devices()` |
| 感知范围与麦克风 | `miloco_perception_scope()` |
| 引擎状态 | `miloco_perception_engine_status()` |
| 原始事件流 | `miloco_event_list(...)` |

## 选对工具

- **画面/声音** → `miloco_perceive`。例如“门口有没有人”“电视开着吗”“刚才是谁在说话”。
- **数值** → `miloco_device_status`。温度、湿度、电量、PM2.5 不归视觉模型回答。
- **设备开关状态**：优先 `miloco_device_status`；设备不上报时可用 `miloco_perceive` 做画面核实，并说明这是视觉判断。

## 提问流程

1. 先用 `miloco_perception_devices` 或 `miloco_camera_list` 确认摄像头 did 和是否在感知。
2. 用户说房间名时，用 `miloco_device_list` / `miloco_home_info` 映射到摄像头 did，不猜。
3. `miloco_perceive` 的 `query` 写成一个明确问题，一次问一件事；需要多个结论时分多次问。
4. 回答时区分“模型看到的”与“设备上报的”，不要把手势、表情等推断说成事实。

## 回顾事件

1. `miloco_perception_logs(limit, since)` 按时间倒序取近期事件。
2. 需要按类型/来源过滤时用 `miloco_event_list`。
3. 只引用返回里存在的事件，不补写时间、人物或地点。

## 隐私

- 摄像头未开启感知时，`miloco_perceive` 会失败；提示用户到 Miloco 面板或 `miloco-miot-scope` 技能开启。
- 不要把画面内容扩散到无关会话；回答保持必要范围。
