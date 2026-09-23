---
id: MOD-retention
kind: module
title: 存储保留与删除治理
status: current
summary: 对规范版本、投影缓存和已删除会话执行预览、保留及可恢复清理。
sources:
  - {role: implementation, workspace_id: source, path: apps/engine/src/retention-service.ts}
  - {role: implementation, workspace_id: source, path: packages/session-store/src/index.ts}
---
保留策略依据逻辑会话、版本引用和恢复依赖区分仍需保留的原件与可清理缓存；删除预览、回执和最近删除入口让用户理解影响。物理清理不应绕过规范墓碑、检查点或宿主写入协议。代码图可进一步追踪存储层的具体访问关系。
