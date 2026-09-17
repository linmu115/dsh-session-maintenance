---
id: MOD-continuation
kind: module
title: Codex 续接与恢复作业
status: current
summary: 固定来源版本生成交接材料，显式创建新的 Codex 原生任务。
relations:
- relation: consumes
  to:
    record_id: IF-harness-adapter
  reason: 使用独立 CodexContinuationPort
sources:
- path: ../../packages/contracts/src/continuations.ts
- path: ../../packages/continuation-engine/src/service.ts
- path: ../../packages/handoff-context/src/index.ts
- path: ../../tests/integration/phase-3-continuation.test.ts
---

# Codex 续接与恢复作业

ContinuationService 选来源版本及目标 preset，HandoffBuilder 预览材料、遗漏和预算。创建前保存交接对象及 requestHash，复用同请求作业；通过 CodexContinuationPort 探针后创建新任务，先登记 threadId，再核验历史/工作目录并保存状态。恢复按作业处理，不盲目创建第二个线程。

full / checkpoint / structured-summary 都是明确模式，超预算不偷偷降级。resolution 需要左右版本及 mergeNote；它和图中多入边不是同一操作。只读导入和 DSH 续写也不是这条能力。

唯一合同 [ContinuationJob 与 Port](../../../../../../packages/contracts/src/continuations.ts)；实现 [ContinuationService](../../../../../../packages/continuation-engine/src/service.ts)、[HandoffContext](../../../../../../packages/handoff-context/src/index.ts)，平台实现 [[MOD-harness-codex]]。历史合成测试 [续接集成测试](../../../../../../tests/integration/phase-3-continuation.test.ts)，本轮未创建任务或运行模型。
