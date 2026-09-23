---
id: MOD-continuation
kind: module
title: 固定规范版本的 Codex 续接
status: current
summary: Engine 管理续接作业与来源版本，Codex 适配器负责目标任务通信和持久回执。
sources:
  - {role: implementation, workspace_id: source, path: packages/continuation-engine/src/service.ts}
  - {role: adapter, workspace_id: source, path: packages/adapter-codex-continuation/src/adapter.ts}
---
续接先冻结逻辑会话版本、选择目标 Codex 任务，再由适配器按其协议注入；结果和失败原因作为作业保存，重试先检查先前回执，不能因网络不确定而盲目重复。Maintenance 不因存在续接能力而获得 Codex 原始日志的写入权。学习会话的定向交接在此能力上增加双端边界条件，见 [[REQ-learning-roundtrip]]。
