---
name: miloco-miot-scope
description: 管理感知范围——哪些摄像头参与感知、麦克风是否启用、每台摄像头的感知须知。涉及隐私，改动前必须确认。
whenToUse: 用户说“别让某个摄像头看”“只用客厅摄像头”“把声音关了”“门口老误报”“这台别裁切”等。
---

# 感知范围

## 工具

| 目的 | 工具 |
|---|---|
| 查看范围 | `miloco_perception_scope()` |
| 查看正在感知 | `miloco_perception_devices()` |
| 摄像头清单 | `miloco_camera_list()` |
| 修改范围（写） | `miloco_scope_set(items)` |

## 读取

1. `miloco_camera_list` 拿 did、名称、房间。
2. `miloco_perception_scope` 看 `in_use`、麦克风、感知须知等字段。
3. 用房间/名称把用户说的“门口摄像头”映射到 did，不猜。

## 修改

`miloco_scope_set` 的 `items` 是 `[{did, in_use}]`：

- `in_use=true` 开始感知
- `in_use=false` 停止感知

注意：

- 只提交要改的摄像头，不要整表覆盖。
- 关闭感知等于停止录像分析，属于隐私相关操作，先复述影响并确认。
- 麦克风、感知须知、Smart Crop 等字段如果后端 scope 接口未提供写入，
  应引导用户到 Miloco 面板修改，不要声称已经改好。

## 边界

- 不要用 `miloco_device_control` 关机摄像头来代替“停止感知”；两者语义不同。
- 感知范围改动后，用 `miloco_perception_scope` 复查。
- 只读模式没有 `miloco_scope_set`。
