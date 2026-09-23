---
id: IF-runtime
kind: interface
title: 运行准备与宿主提交合同
status: current
summary: Engine 固定运行边界并管理回执；宿主 provider 负责准备、追加、排空和关闭的实际执行。
sources:
  - {role: contract, workspace_id: source, path: packages/contracts/src/projection.ts}
  - {role: implementation, workspace_id: source, path: apps/engine/src/runtime-broker.ts}
---
输入是稳定目标身份、规范版本和本次范围；准备阶段确认租约、原生空间与可恢复状态。宿主 provider 返回实际追加、flush/close 和持久回执；失败或回执不确定要保留可检查状态，不能直接宣称成功或重放。格式和 Launcher 生命周期协议留在接入 adapter，Maintenance 核心消费通用运行结果。旧合同位置：`d3fdbe3:docs/project/records/modules/engine/runtime/contract.md`。
