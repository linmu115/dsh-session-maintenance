---
id: MOD-host
kind: module
title: 宿主接入：Provider、插件与桥
status: current
summary: Provider 连接启停，DSH 插件接官方持久化并提供当前运行绑定的服务。
relations:
- relation: provides
  to:
    record_id: IF-extension-pages
  reason: 当前公开贡献入口，最终组合验证见 VER-scope-business-pages
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

**启停边界**：本仓 ExternalLifecycleProvider 在匹配版本中响应 Launcher Hook 的 recoverBeforeStart/prepare/started/beforeStop/afterExit/abort 时机，准备空间、排空和恢复；Hook 自身属于外部 Launcher，配置不能补出缺失能力。

**运行边界**：DSH 插件 attach 官方 persistence seam，按需加载并直接向 Engine 追加，取得回执才确认。凭据在宿主，浏览器不能持有 Engine token。

插件分别提供 maintenanceExtensionData、maintenanceSessionContext、maintenanceGraph、maintenanceNativeContext，转发对象、固定引用、图及原生状态，权限并不相同。

[Provider](../../../../../apps/engine/src/external-lifecycle-provider.ts)、[运行接入](../../../../../plugins/dsh-session-maintenance/src/projection-runtime.ts)、[RC2 persistence](../../../../../plugins/dsh-session-maintenance/src/rc2-persistence.ts)、[插件注册](../../../../../plugins/dsh-session-maintenance/src/index.ts)为实现入口。合同 [[IF-runtime]]、[[IF-extension]]、[[IF-graph]]、[[IF-native-context]]。

## 可选业务贡献注册（已接入，最终验证进行中）

[[IF-extension-pages]] 要求宿主按能力挂载各插件自己的贡献并汇总接入名单，支持晚加载、禁用和恢复。Maintenance 不硬依赖 Obsidian／Core 的运行服务；缺席不阻断会话维护。实例范围与身份由受信宿主传递，不以浏览器自报值替代。

当前运行范围服务见 [[MOD-instance-workspace]]；公开信息页与贡献者生命周期见 [[MOD-business-pages]]。实现和最终验证边界分别见 [[IMP-scope-business-pages]]、[[VER-scope-business-pages]]。

## 本轮启动与停止限制

双击/命令启动需发现当前配置、检查已有Engine并复用；状态核验通过稳定instance/profile/实际home及本次boot/run，不固定端口。2026-09-18工作区包装命令只有Status/Start已核验；当前Launcher没有正式外部停止入口，Stop/Restart必须在任何退出前拒绝。Tauri内部IPC方法不是CLI，直接runtime shutdown会缺少beforeStop停止意图并走恢复路径，不能当正常停止。必须正常flush/drain/close并核对run=closed、handle=finalized、finalReceipt=closed后才能重启。

2026-09-19 已部署匹配的 Launcher 与 .41 startup-recovery 修订。启动先检查旧运行，有退出证明才走正式恢复；新进程启动后保存身份。升级 Launcher 后必须重新核验能力回执及接入绑定，保持 Engine 入口、构件 pin 和双击启动目录一致。当前部署及边界见 [[IMP-startup-recovery]]、[[VER-startup-recovery]]；.38/.39 状态作为历史保留。
