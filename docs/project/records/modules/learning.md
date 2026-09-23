---
id: MOD-learning
kind: module
title: 实验性学习交接协调
status: current
summary: 为已确认双端绑定保存交接边界、排除普通镜像并按回执回收 Codex 新问答。
sources:
  - {role: implementation, workspace_id: source, path: apps/engine/src/learning-service.ts}
  - {role: frontend, workspace_id: source, path: apps/dashboard/src/learning-page.tsx}
---
`LearningService` 协调绑定、同步和回收，定向 Codex 协议由 [[MOD-continuation]] 提供，DSH 正文与版本由 [[MOD-core]]、[[MOD-dsh-host]] 提供。权限条件和冲突阻断以 [[REQ-learning-roundtrip]] 为准。实验入口及历史局部成功不代表真实新问答往返已完成验收。
