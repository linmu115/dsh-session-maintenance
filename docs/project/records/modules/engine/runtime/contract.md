---
id: IF-runtime
kind: interface
title: 宿主怎样准备和提交运行
status: current
summary: 宿主交付运行与追加意图，Engine 返回受绑定的持久结果。
sources:
- path: ../../packages/contracts/src/runtime-broker.ts
- path: ../../packages/contracts/src/external-lifecycle.ts
- path: ../../packages/contracts/src/projection.ts
- path: ../deployment/launcher-hook.md
---

# 宿主怎样准备和提交运行

调用者交付实例/Profile/Adapter 环境、运行身份及原生追加。Engine 返回准备句柄、运行绑定和持久回执；新回答只有取得 committed 才算提交到 Maintenance。

唯一技术合同：[Runtime Broker DTO](../../../../../../packages/contracts/src/runtime-broker.ts)、[外部生命周期 DTO](../../../../../../packages/contracts/src/external-lifecycle.ts)、[运行及回执](../../../../../../packages/contracts/src/projection.ts)。原生格式内部的 RuntimeBridge 见 [[IF-harness-adapter]]。

[[MOD-host]] 的 Provider 管 prepare/stop/exit/recover，DSH 插件 append/flush 并排空。握手失败、租约冲突、格式不兼容、尾部不收敛均须保留证据并停止相应动作。重试回执绑定同一 operationId 及目标。

[Launcher Hook 接入指南](../../../../../deployment/launcher-hook.md)解释外部宿主时机；配置存在或源码注册不是实际部署启用证据。

## 启动前恢复及进程身份（匹配版本可选）

Launcher 交付稳定实例/profile，请 Provider 检查并恢复安全可回收的旧运行；恢复成功才 prepare，新子进程创建后再登记 PID。`recoverBeforeStart` 以 `ok` 回执确认可以继续，`started` 保存系统验证后的 PID、创建时间及 OS 启动时间。缺失退出证据、仍活跃或恢复失败时停止本次启动并说明原因，不修改历史来绕过校验。

两个阶段由独立 `runtime-lifecycle.startup-recovery.json` 开关启用，未启用的旧 Provider 不收到新增请求。具体证明规则与回执要求见 [[IMP-startup-recovery]]；真实安装和覆盖边界见 [[VER-startup-recovery]]。正常停止的 closed 标准与异常恢复的 recovered 路径分别保留。
