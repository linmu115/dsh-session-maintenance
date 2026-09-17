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
