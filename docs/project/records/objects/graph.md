---
id: OBJ-graph
kind: object
title: 每会话主干、固定引用与披露日志
status: current
summary: 图的来源许可、布局与实际读取位置分别维护。
sources:
- path: ../reports/2026-09-15-graph-reference-lifecycle-release.md
- path: ../../packages/contracts/src/session-graph.ts
- path: ../../packages/contracts/src/session-context.ts
---

# 每会话主干、固定引用与披露日志

X → Y 表示 Y 在固定来源版本和已完成回复截止内使用 X。Y 的主干按 ownerSessionId 按需创建，来源节点不是会话历史双亲。空卡片只有布局/创建意图，正式开始时才绑定真实会话；pending 连接不能声明读取权限。

活动边引用 annotation-upstream 的权威关系。唯一字段定义见 [managedGraphSchema 与图 DTO](../../../../packages/contracts/src/session-graph.ts)、[固定来源合同](../../../../packages/contracts/src/session-context.ts)。

披露日志只保存返回范围、游标、计数、来源与交付状态，不复制上游全文；准备或失败结果不是已返回覆盖。日志修订独立于布局，历史覆盖独立于当前保留材料。

移除走统一撤销，同步来源蓝标，停止后续披露，保留真实会话与旧回答。归档撤销涉及该会话的活动引用并归档自身主干，恢复不使引用复活。接口 [[IF-graph]]，释放 [[IF-native-context]]；全局网络等已移出确认范围，见 [[DEC-authority]]。
