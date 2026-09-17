---
id: INT-thoughtdag
kind: implementation
title: ThoughtDAG：主干领域与上下文视图
status: current
summary: 维护模式消费图领域保存、固定来源和原生状态，不直接覆盖受管对象。
relations:
- relation: consumes
  to:
    record_id: IF-graph
  reason: 主干、布局、绑定、移除和披露目录
- relation: consumes
  to:
    record_id: IF-extension
  reason: thoughtdag 格式兼容及对象元数据
- relation: consumes
  to:
    record_id: IF-native-context
  reason: 状态和用户窗口/释放操作
- relation: related_to
  to:
    project_id: 9b066b81-bb0e-4c2a-b528-56c24499f886
  reason: 独立 ThoughtDAG 消费方地图
sources:
- path: ../../plugins/dsh-session-maintenance/src/session-graph.ts
- path: ../../apps/engine/src/session-graph-service.ts
- path: ../../apps/engine/src/extensions/service.ts
---

# ThoughtDAG：主干领域与上下文视图

maintenanceGraph protocol 2 提供 directory/resolve/preview、ensure/load/save/bind、remove、relations/disclosures/sourceMarkers。插件发出布局及延迟开始意图，Engine 核对修订、身份和授权。

图存在 thoughtdag namespace，但 managedSchema 2 的通用 write 被拒绝，保存/移除不能只接 ExtensionBridge.save。浏览器保留未确认编辑，旧图关联会话不自动成为 owner。

ThoughtDAG 界面通过 [[IF-native-context]] 查看窗口、保留和回执并发起用户操作；Core 执行模型工具与真实 surface 替代，图关闭不停止后端。

本仓证据 [MaintenanceGraph](../../../../../../../plugins/dsh-session-maintenance/src/session-graph.ts)、[领域实现](../../../../../../../apps/engine/src/session-graph-service.ts)、[通用写入保护](../../../../../../../apps/engine/src/extensions/service.ts)。唯一合同 [[IF-graph]]、[[IF-extension]]、[[IF-native-context]]，外部完整实现由 ThoughtDAG 独立地图维护。当前声明含 0.4.14-rc2.13；本轮未启动插件。
