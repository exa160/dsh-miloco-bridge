---
name: miloco-devices
description: 查询和控制米家设备——读开关、温度、湿度、电量、PM2.5 等属性，开关灯、调空调、控制窗帘、启动扫地机、开关摄像头，并触发米家手动场景。用户提到具体设备动作、设备状态或场景时使用。
whenToUse: 用户说“开/关/调/查某台设备”“客厅多少度”“执行回家模式”等；只想看摄像头画面或听声音时改用 miloco-perception。
---

# 设备与场景

本技能只使用插件原生工具，不执行 shell 命令。

## 工具

| 目的 | 工具 |
|---|---|
| 找设备 did | `miloco_device_list(room?)` |
| 读 SPEC / iid | `miloco_device_spec(did)` |
| 读当前属性 | `miloco_device_status(did, iid?)` |
| 控制设备（写） | `miloco_device_control(...)` |
| 列场景 | `miloco_scene_list()` |
| 触发场景（写） | `miloco_scene_trigger(scene_id)` |

## 查询流程

1. `miloco_device_list` 拿 did。名字相同或跨房间时先缩小范围，不猜。
2. `miloco_device_status` 读状态。传 `iid` 读单项，不传读全部。
3. 回答里带上设备名、房间、关键数值和时间（若后端返回）。

## 控制流程

1. **先 `miloco_device_spec`**。控制时 `iid` 必须是 spec 行首列，形如 `prop.2.1`；动作形如 `action.2.1`。
2. 核对 `access`：`w` 可写、`r` 可读、`x` 动作、`n` 会主动上报。
3. 按 `set_property` / `set_properties` / `call_action` 三种类型调用：
   - 单属性：`miloco_device_control(did, type="set_property", iid, value)`
   - 多属性：`miloco_device_control(did, type="set_properties", properties=[{iid,value},…])`
   - 动作：`miloco_device_control(did, type="call_action", iid, params=[…])`，参数只传值，按 spec 顺序。
4. 枚举和范围严格按 spec，不套默认档位（不要把“高”猜成 3）。
5. 控制后再读一次状态确认，失败时报告后端错误原文。

## 安全边界

- 只读模式下写工具**根本没有注册**。如果模型看不到 `miloco_device_control`，说明当前是只读模式，应向用户说明需要在「设置 → 插件 → Miloco」切到管家模式。
- 门锁、燃气阀、摄像头开关、厨房电器等有物理风险的操作，先说明将要做什么并取得确认。
- 不要把“感知事件里的 did”当成控制目标：事件 did 通常是摄像头/传感器。
- 不确定设备是否存在时重新 `miloco_device_list` 或 `miloco_home_info(refresh=true)`，禁止编造 did。

## 场景

1. `miloco_scene_list` 取 `scene_id` 与名称。
2. 用户说“回家模式”时匹配名称，不匹配就问。
3. `miloco_scene_trigger` 会一次执行多个设备动作，执行前确认一次。
