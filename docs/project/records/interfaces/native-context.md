---
id: IF-native-context
kind: interface
title: 原生上下文保留与释放证据
status: current
summary: 固定授权与预期窗口是意图，宿主实际保留/释放材料需独立回执证明。
sources:
  - {role: implementation, workspace_id: source, path: apps/engine/src/native-context-service.ts}
  - {role: provider, workspace_id: source, path: plugins/dsh-session-maintenance/src/native-context.ts}
---
调用方给出目标会话、授权、窗口与保留/释放意图；宿主返回实际执行证据或明确拒绝。Maintenance 可以保存计划和回执，不能仅凭提交意图说材料已从当前 Agent 上下文消失。适用原生 Agent，不扩展到托管内部资源释放。旧合同位置：`d3fdbe3:docs/project/records/modules/engine/native-context/contract.md`。
