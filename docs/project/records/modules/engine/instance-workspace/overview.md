---
id: MOD-instance-workspace
kind: module
title: 实例分类工作区策略与运行范围
status: current
relations:
- relation: provides
  to:
    record_id: IF-instance-workspace-scope
---

# 实例分类工作区策略与运行范围

用户选择的是 Maintenance 的逻辑分类工作区。每个稳定实例持久保存同步策略（全部、明确 ID 集及未分类开关），配置使用 CAS；保存影响下次启动，当前 run 使用已冻结的 policy snapshot 完成写入，不按新名单突然改投。

InstanceWorkspaceRuntime 提供配置、有效范围和会话可用性；session-store policy repository 保存策略及 run 快照。CanonicalProjectionSource 按该快照过滤会话并保留选中工作区的祖先标题；persistent cache 配置包含实例/profile/branch 及 scope revision。Canonical commit 在异步对象落盘后、事务内再次核对快照范围、当前成员关系与删除状态，失败不推进 head 或 receipt。

Host maintenanceInstanceIdentity/maintenanceInstanceWorkspace 绑定实际实例/profile，只提供无 Engine 凭据的有效范围与 availability。not-found、deleted、not-synced、offline、mapping-pending、available 分开；Bridge 可选消费，不另存 Vault 工作区名单。

权威实现：apps/engine/src/instance-workspace-runtime.ts、instance-workspace-service.ts；packages/session-store/src/instance-workspace-policy-repository.ts、canonical-projection-source.ts、canonical-engine-store.ts；plugins/dsh-session-maintenance/src/instance-workspace.ts。设计合同 [[IF-instance-workspace-scope]]，进展与验证 [[IMP-scope-business-pages]]、[[VER-scope-business-pages]]。
