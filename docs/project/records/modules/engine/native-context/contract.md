---
id: IF-native-context
kind: interface
title: 释放材料怎样才算生效
status: current
summary: 保存意图后，由持久 surface 替代证据确认输入变化。
sources:
- path: ../../packages/contracts/src/native-context.ts
- path: ../../packages/contracts/src/native-context-evidence.ts
- path: ../../packages/contracts/src/user-request-index.ts
- path: ../../plugins/dsh-session-maintenance/src/native-context.ts
---

# 释放材料怎样才算生效

授权上限是最多可读范围，活动窗口是当前可披露范围，保留集合是下一模型输入携带的材料；历史覆盖不能因释放变成未读。

唯一技术合同：[原生上下文 DTO/状态](../../../../../../packages/contracts/src/native-context.ts)、[材料及释放证据](../../../../../../packages/contracts/src/native-context-evidence.ts)、[稳定请求目录](../../../../../../packages/contracts/src/user-request-index.ts)。

释放先保存 operationId 与意图，可返回 pending-next-step。Core 原生 Agent 在 pre-step 串行边界追加 surfaceOp replace / sourceEventSeqs，保留日志与工具配对；Maintenance 宿主 flush 后交回执，Adapter 验证实际持久替代，Engine 才确认 applied。失败/缺能力返回 failed/unsupported，隐藏气泡或清空预算不算释放。

[MaintenanceNativeContext](../../../../../../plugins/dsh-session-maintenance/src/native-context.ts)区分普通操作与仅原生宿主可调用的材料登记、释放计划和生效回执。调用者不能任选 owner/profile/run 扩权；用户固定、共享持有、撤销状态与预期修订均需核对。

已知接入 [[INT-annotation]] 的原生工具/执行层与 [[INT-thoughtdag]] 的状态及用户操作。当前仅 DSH 0.1.5-rc.2 原生 Agent；字节差不是精确 token，也不能撤回已发出的请求。
