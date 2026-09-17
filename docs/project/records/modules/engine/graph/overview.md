---
id: MOD-graph
kind: module
title: 固定引用与主干领域
status: current
summary: Engine 校验来源、完成截止、归属、修订及撤销，Adapter 解释平台完成语义。
relations:
- relation: provides
  to:
    record_id: IF-graph
- relation: consumes
  to:
    record_id: IF-harness-adapter
  reason: 固定截止与完成回复解析
- relation: implements
  to:
    record_id: REQ-source
- relation: implements
  to:
    record_id: REQ-main-graph
- relation: implements
  to:
    record_id: REQ-graph-removal
sources:
- path: ../../apps/engine/src/session-context-service.ts
- path: ../../apps/engine/src/session-graph-service.ts
- path: ../../apps/engine/src/session-graph-store.ts
---

# 固定引用与主干领域

SessionContextService 捕获固定来源与截止、管理有界读取和预算；SessionGraphService 提供主干、关系、披露日志、来源标记与归档联动。图和引用变更在统一领域事务中保存，布局不制造授权。

completedTurn / cutoff / entries 等原生语义来自版本 Adapter；Engine 不猜原生编号。Core 管引用实际发送和准备；Maintenance 宿主提供绑定当前运行的 maintenanceSessionContext / maintenanceGraph。

合同 [[IF-graph]]，对象 [[OBJ-graph]]。实现 [SessionContextService](../../../../../../apps/engine/src/session-context-service.ts)、[SessionGraphService](../../../../../../apps/engine/src/session-graph-service.ts)、[图存储事务](../../../../../../apps/engine/src/session-graph-store.ts)；消费说明 [[INT-annotation]]、[[INT-thoughtdag]]。
