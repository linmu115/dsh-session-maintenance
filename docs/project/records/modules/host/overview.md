---
id: MOD-host
kind: module
title: 宿主接入：Provider、插件与桥
status: current
summary: Provider 连接启停，DSH 插件接官方持久化并提供当前运行绑定的服务。
relations:
- relation: consumes
  to:
    record_id: IF-runtime
  reason: Provider/插件运行与提交
- relation: consumes
  to:
    record_id: IF-extension
  reason: 当前实例的对象桥
- relation: consumes
  to:
    record_id: IF-graph
  reason: 当前运行固定引用/图桥
- relation: consumes
  to:
    record_id: IF-native-context
  reason: 材料登记及持久回执桥
sources:
- path: ../../apps/engine/src/external-lifecycle-provider.ts
- path: ../../plugins/dsh-session-maintenance/src/projection-runtime.ts
- path: ../../plugins/dsh-session-maintenance/src/rc2-persistence.ts
- path: ../../plugins/dsh-session-maintenance/src/index.ts
---

# 宿主接入：Provider、插件与桥

**启停边界**：本仓 ExternalLifecycleProvider 响应 Launcher Hook 的 prepare/beforeStop/afterExit/abort 时机，准备空间、排空和恢复；Hook 自身属于外部 Launcher，配置不能补出缺失能力。

**运行边界**：DSH 插件 attach 官方 persistence seam，按需加载并直接向 Engine 追加，取得回执才确认。凭据在宿主，浏览器不能持有 Engine token。

插件分别提供 maintenanceExtensionData、maintenanceSessionContext、maintenanceGraph、maintenanceNativeContext，转发对象、固定引用、图及原生状态，权限并不相同。

[Provider](../../../../../apps/engine/src/external-lifecycle-provider.ts)、[运行接入](../../../../../plugins/dsh-session-maintenance/src/projection-runtime.ts)、[RC2 persistence](../../../../../plugins/dsh-session-maintenance/src/rc2-persistence.ts)、[插件注册](../../../../../plugins/dsh-session-maintenance/src/index.ts)为实现入口。合同 [[IF-runtime]]、[[IF-extension]]、[[IF-graph]]、[[IF-native-context]]。
