---
id: MOD-harness-codex
kind: module
title: Codex：只读来源与原生续接
status: current
summary: 来源读取不写日志；新任务创建使用独立端口。
relations:
- relation: consumes
  to:
    record_id: IF-harness-adapter
  reason: 实现 SessionReadAdapter 与独立 CodexContinuationPort
sources:
- path: ../../packages/adapter-codex-read/src/index.ts
- path: ../../packages/adapter-codex-read/src/stable-read.ts
- path: ../../packages/adapter-codex-continuation/src/adapter.ts
---

# Codex：只读来源与原生续接

CodexReadAdapter 执行 probe/list/observe/normalize/verify，稳定读取检查变化，规范化保留可信角色和事实。Engine 决定纳入范围、工作区和逻辑身份。

CodexContinuationAdapter 探测原生协议，通过 create/verify 创建任务并核验历史与目录；ContinuationService 管材料、预算、幂等和作业恢复。这不是复制日志到 Home 的文件写入功能。

合同 [[IF-harness-adapter]]；实现 [CodexReadAdapter](../../../../../../packages/adapter-codex-read/src/index.ts)、[稳定读取](../../../../../../packages/adapter-codex-read/src/stable-read.ts)、[CodexContinuationAdapter](../../../../../../packages/adapter-codex-continuation/src/adapter.ts)。调用者分别 [[MOD-canonical]]、[[MOD-continuation]]。本次未探测本机 Codex 或创建任务。

## 绑定学习会话的交接适配

实验模式新增 CLI 0.153.4 legacy 历史读取和同任务注入，复用任务身份、校验日志前缀，不创建续接任务。普通扫描让位于已确认的学习绑定；上下文持久化及下一轮请求验证见 [[VER-learning-roundtrip]]，使用边界见 [[IMP-learning-roundtrip]]。
