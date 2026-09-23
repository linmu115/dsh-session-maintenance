---
id: MOD-codex
kind: module
title: Codex 只读来源与项目镜像
status: current
summary: 读取 Codex 数据库及日志、规范化会话和项目归属；不直接改写 Codex 原件。
sources:
  - {role: implementation, workspace_id: source, path: packages/adapter-codex-read/src/index.ts}
  - {role: implementation, workspace_id: source, path: apps/engine/src/codex-project-observer.ts}
---
Codex 读取适配器通过稳定快照、格式探测和事件规范化观察原日志；Engine 保存可追溯版本、项目映射和镜像策略。读取支持标题、工作区、可见正文与来源分类，遇未知格式应保留证据并拒绝擅自改写。Codex 项目名单与 DSH 维护工作区名单是两套范围。镜像派生和续接分别见 [[MOD-core]]、[[MOD-continuation]]。
