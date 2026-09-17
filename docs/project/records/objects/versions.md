---
id: OBJ-version
kind: object
title: 版本、谱系、检查点与续接
status: current
summary: 不可变版本、来源派生与图中上下文连线分别表达不同事实。
sources:
- path: ../../packages/contracts/src/model.ts
- path: ../../packages/contracts/src/canonical.ts
- path: ../../packages/session-domain/src/graph.ts
- path: ../../packages/continuation-engine/src/service.ts
---

# 版本、谱系、检查点与续接

**版本**保存一个会话的不可变内容和父版本，会话 head 指向当前版本；检查点固定恢复位置。**来源派生**记录 Codex 镜像首次在 DSH 续写后的新逻辑身份与来源版本。**主干连线**表达固定范围的上下文引用，不能写成 version_parents 或自动拼接两个会话历史。

[[MOD-continuation]] 的显式 resolution 续接另有左右版本与 mergeNote，建立可追踪的解决版本后创建 Codex 任务；不能由画一条图边触发。

合同见 [会话版本模型](../../../../packages/contracts/src/model.ts)、[Canonical 来源定义](../../../../packages/contracts/src/canonical.ts)；[VersionGraph](../../../../packages/session-domain/src/graph.ts)与[ContinuationService](../../../../packages/continuation-engine/src/service.ts)是实现入口。旧设计的后继范围见 [[DEC-authority]]。
