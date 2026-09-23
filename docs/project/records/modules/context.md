---
id: MOD-context
kind: module
title: 原生 Agent 上下文与固定引用
status: current
summary: 管理上下文窗口、保留/释放意图和引用来源边界，实际生效以宿主证据核验。
sources:
  - {role: implementation, workspace_id: source, path: apps/engine/src/native-context-service.ts}
  - {role: implementation, workspace_id: source, path: apps/engine/src/session-context-service.ts}
---
上下文管理区分用户授权、计划窗口、实际保留材料及释放证据，不能因界面显示意图就声称宿主已经释放。跨会话引用固定来源版本和已完成内容边界，不随来源后来续写自动扩大。此处是维护会话的通用边界与证据，不解释 Lynn 插件图或其它业务对象。旧设计来源见 [[REQ-context]]、[[REQ-source]]，物理提供者见 [[MOD-dsh-host]]。
