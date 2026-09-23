---
id: MOD-runtime
kind: module
title: 运行准备、原生空间与恢复
status: current
summary: 管理投影准备、租约、追加、关闭、检查点和恢复；宿主执行与物理写入由适配器提供。
sources:
  - {role: implementation, workspace_id: source, path: apps/engine/src/runtime-broker.ts}
  - {role: implementation, workspace_id: source, path: packages/projection-lifecycle/src/index.ts}
  - {role: implementation, workspace_id: source, path: packages/transaction-engine/src/index.ts}
---
运行前固定来源版本与范围，预检目标、准备持久原生空间和租约；运行中记录投影与追加状态；关闭时等待宿主完成 flush / drain / close 并核对最终回执。中断恢复依据事务日志、检查点和真实宿主状态，不能把端口不可达或健康接口通过单独当作生命周期证据。与 Launcher 的具体启动/停止联动属于宿主接入边界，当前装配耦合见 [[ISS-remaining-coupling]]。
