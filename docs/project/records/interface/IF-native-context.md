---
id: IF-native-context
kind: interface
title: 释放材料怎样才算生效
status: current
summary: 保存释放意图后，宿主下一次请求应用替代事件，Engine 核验持久证据再确认。
relations:
- relation: derived_from
  to:
    record_id: REQ-context
- relation: consumes
  to:
    record_id: IF-reference
    project_id: dd46311f-d98d-49ff-ae13-fef0a8a6f9c3
sources:
- file: ../superpowers/specs/2026-09-15-native-agent-context-management.md
- file: ../changes/2026-09-15-native-context-management.md
---

# 释放材料怎样才算生效

固定授权上限决定最多能看哪里；活动窗口决定这次允许披露哪一部分；实际保留描述下一模型输入仍带哪些材料。这三者不能用一个“已读”标记代替。

模型和用户通过同一后端操作当前执行会话。暂停阻止新披露，释放影响后续输入，撤销取消引用。释放先可能显示待生效；必须由原生 surface 替代事件和持久回执核验后才显示已生效。旧历史不擦除，累计读取预算不返还，用户固定项不能被模型随意释放。

目前新能力只适用于 RC2 原生 Agent。托管执行路径、缺能力组合不能声称支持。字节节省不等于精确 token，也不能撤回已发出的请求。
