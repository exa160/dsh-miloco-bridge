---
name: miloco-miot-identity
description: 家庭成员花名册的增删改查——创建、列出、改名、改角色、删除成员。人脸/身形样本注册走 miloco-miot-identity-register，本技能不处理样本。
whenToUse: 用户说“加一个家庭成员”“把爸爸改成…”“删除某成员”“家里登记了哪些人”时。
---

# 家庭成员花名册

## 工具

| 目的 | 工具 |
|---|---|
| 列出成员 | `miloco_person_list()` |
| 新增（写） | `miloco_person_create(name, role?)` |
| 修改（写） | `miloco_person_update(person_id, name?, role?)` |
| 删除（写） | `miloco_person_delete(person_id)` |

## 流程

1. 先 `miloco_person_list` 查重；同名成员用 role 或 id 区分。
2. 新增时确认姓名与家庭角色；角色用“爸爸/妈妈/奶奶”这类家庭称谓。
3. 修改时只改用户要求的字段，不动其他成员。
4. 删除会连同该成员的识别样本一起移除，**必须二次确认**。
5. 操作后重新 `miloco_person_list` 复查。

## 与档案、样本的关系

- 花名册只建身份行；偏好/习惯写在家庭档案里（`miloco-home-profile`）。
- 让系统认识某人的脸/身形，走 `miloco-miot-identity-register`。
- 删除成员前先看家庭档案里是否有该 person_id 的条目，提醒用户影响范围。

## 边界

- 只读模式没有写工具，只输出建议。
- 不把成员姓名、样本数量等发到无关会话。
