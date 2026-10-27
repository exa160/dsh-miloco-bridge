---
name: miloco-miot-pet-register
description: 宠物成员登记——用文字描述或照片/视频建立宠物花名册与外观参照，也支持补充素材。用户说“记住我家的猫/狗”“这是胖胖”时使用。
whenToUse: 用户要登记宠物、补充宠物照片、修改宠物信息，或问“家里登记了哪些宠物”时。
---

# 宠物登记

## 工具

| 目的 | 工具 |
|---|---|
| 列出宠物 | `miloco_pet_list()` |
| 新建花名册（写） | `miloco_pet_create(name, species?)` |
| 修改（写） | `miloco_pet_update(pet_id, name?, species?)` |
| 观察外观（不落库） | `miloco_pet_observe(files[], grounding?)` |
| 落库参照图（写） | `miloco_pet_reference_crops(pet_id, files[])` |
| 删除（写） | `miloco_pet_delete(pet_id)` |

## 流程

### 纯文字描述

1. `miloco_pet_list` 查重。
2. `miloco_pet_create(name, species)` 建花名册。
3. 把用户提供的外观描述整理后写入家庭档案（`miloco-home-profile` 的 `device` 或
   `family` 条目），或作为后续识别的说明。

### 图片/视频

1. 先 `miloco_pet_create` 建花名册，拿到 `pet_id`。
2. `miloco_pet_observe(files)` 生成共性外观（只观察不落库）。
3. 把外观描述给用户确认。
4. `miloco_pet_reference_crops(pet_id, files)` 落库参照图。
5. `miloco_pet_list` 复查。

## 边界

- 宠物没有“陌生宠物池”，不要从摄像头记录里自动挑宠物登记。
- 只使用用户主动提供的素材。
- 删除宠物前二次确认。
- 只读模式只输出登记建议，不写库。
- 文件名用本地绝对路径；不要把图片内容贴进聊天。
