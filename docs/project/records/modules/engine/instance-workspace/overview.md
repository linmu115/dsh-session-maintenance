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

2026-09-20 起，实例主动新建的工作区是明确例外：Engine 先持久登记工作区和创建意图，再把该工作区加入发起 run 的有效范围及实例保存名单，然后完成会话登记。只增加本次新建 ID，不应用其它待生效名单，也不修改其它运行。初始缓存修订单独保留，避免正常关闭时缓存身份变化。详见 [[REQ-runtime-workspace-creation]]。

RuntimeWorkspaceRegistration 优先使用明确工作区、已登记实例/项目绑定或唯一既有项目成员关系；有歧义或既有工作区不在范围内时拒绝，不按名称猜测。原生协议只提供目录时，新目录的工作区在首个会话登记时建立。创建意图以 run/native session 为键，后续会话登记失败可幂等继续，尚未提交会话前允许保留已登记工作区。

同一稳定实例的所有 profile 和已绑定 Vault 共用实例策略；profile/run 仍各自核验身份和实际快照。Codex 项目映射是另一个名单，在 Dashboard 的并列子栏目管理，不把两者合并成一个通用项目列表。

InstanceWorkspaceRuntime 提供配置、有效范围和会话可用性；session-store policy repository 保存策略及 run 快照。CanonicalProjectionSource 按该快照过滤会话并保留选中工作区的祖先标题；persistent cache 配置包含实例/profile/branch 及 scope revision。Canonical commit 在异步对象落盘后、事务内再次核对快照范围、当前成员关系与删除状态，失败不推进 head 或 receipt。

2026-09-20 的恢复路径也按准备时的 scope revision 校验缓存身份。旧版已产生的空登记可通过限定操作工具补齐工作区后走正式恢复，前提是核验实例退出并备份；工具不修改正文、WAL、head 或运行状态。已在本机升级中恢复两条同项目的新会话，见 [部署与恢复验证](../../../../../changes/2026-09-20-runtime-workspace-activation.md)。

Host maintenanceInstanceIdentity/maintenanceInstanceWorkspace 绑定实际实例/profile，只提供无 Engine 凭据的有效范围与 availability。not-found、deleted、not-synced、offline、mapping-pending、available 分开；Bridge 可选消费，不另存 Vault 工作区名单。

权威实现：apps/engine/src/instance-workspace-runtime.ts、instance-workspace-service.ts；packages/session-store/src/instance-workspace-policy-repository.ts、canonical-projection-source.ts、canonical-engine-store.ts；plugins/dsh-session-maintenance/src/instance-workspace.ts。设计合同 [[IF-instance-workspace-scope]]，进展与验证 [[IMP-scope-business-pages]]、[[VER-scope-business-pages]]。

2026-09-18发现配置读取将 recovery-required/quarantined 等所有未关闭记录当成 activeScopes，导致31条相同范围铺开。Engine .39源码已要求 RuntimeBroker.isRunActive 为真；不同在线run即使profile/revision/范围相同仍分别返回，历史和冻结快照不删除。已有run-center的持久state不足以证明在线，前端不猜测过滤。.39独立安装但未激活，实际运行 .38仍可能返回旧列表；Dashboard .1.5仅先折叠详情并限高。见 [[IMP-sync-ui-release]]。
