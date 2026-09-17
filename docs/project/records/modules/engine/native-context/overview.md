---
id: MOD-native-context
kind: module
title: 原生上下文状态与释放核验
status: current
summary: Engine 管授权使用状态，宿主实际替代，Adapter 核验持久证据。
relations:
- relation: provides
  to:
    record_id: IF-native-context
- relation: consumes
  to:
    record_id: IF-harness-adapter
  reason: 原生 surface 与来源证据由版本 Adapter 核验
- relation: implements
  to:
    record_id: REQ-context
sources:
- path: ../../apps/engine/src/native-context-service.ts
- path: ../../plugins/dsh-session-maintenance/src/native-context.ts
- path: ../../packages/contracts/src/native-context-evidence.ts
---

# 原生上下文状态与释放核验

授权范围、活动窗口和输入保留集合分别维护。NativeContextService 提供当前执行会话的状态、窗口、释放、暂停、固定标记及有限图操作；请求索引另由 [[MOD-reader]] 提供。

原生宿主在下一请求前实际追加替代事件，先 flush 再登记材料/回执；DSH 0.1.5 Adapter 核验持久事件、摘要与局部替代，Engine 才确认 applied，忽略宿主自报的释放量。意图、材料句柄和日志都有容量限制。

释放降低后续输入占用但不返还累计读取额度，用户固定项及共享持有者受保护。当前限 RC2 原生 Agent，未支持托管引擎内部释放。

合同 [[IF-native-context]]；实现 [NativeContextService](../../../../../../apps/engine/src/native-context-service.ts)、[宿主桥](../../../../../../plugins/dsh-session-maintenance/src/native-context.ts)、[持久证据类型](../../../../../../packages/contracts/src/native-context-evidence.ts)。历史验证 [[VER-context]]。
