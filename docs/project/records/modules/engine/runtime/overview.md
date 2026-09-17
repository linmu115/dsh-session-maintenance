---
id: MOD-runtime
kind: module
title: 运行准备、追加、关闭与恢复
status: current
summary: Broker 接宿主请求，Lifecycle 管租约、WAL、规范提交与持久空间。
relations:
- relation: provides
  to:
    record_id: IF-runtime
- relation: consumes
  to:
    record_id: IF-harness-adapter
  reason: 选择平台、物化、规范化及运行桥
- relation: implements
  to:
    record_id: REQ-runtime-space
sources:
- path: ../../apps/engine/src/runtime-broker.ts
- path: ../../packages/projection-lifecycle/src/lifecycle.ts
- path: ../../packages/projection-lifecycle/src/append.ts
---

# 运行准备、追加、关闭与恢复

1. Provider/Broker 选择兼容 Adapter，恢复遗留尾部并准备运行。
2. Lifecycle 将已导入 Canonical 差异交给 Adapter 物化；Adapter 检查原生文件及水位。
3. 宿主插件 attach 官方持久化接口，把新增事件直接交给 Engine。
4. commitProjectionAppend 核对运行、会话、operationId/nativeRevision，持久化 WAL，再应用原生追加；Adapter 规范化后由 Canonical Engine 提交，保存回执及映射。
5. drain 排空，close 核对收敛；中断后以 WAL 和回执恢复，无法证明的尾部保留诊断。

Launcher 管启停，不在逐消息路径。证据为 [RuntimeBroker](../../../../../../apps/engine/src/runtime-broker.ts)、[ProjectionLifecycle](../../../../../../packages/projection-lifecycle/src/lifecycle.ts)、[追加提交](../../../../../../packages/projection-lifecycle/src/append.ts)。接口 [[IF-runtime]]、[[IF-harness-adapter]]，空间对象 [[OBJ-runtime]]。
