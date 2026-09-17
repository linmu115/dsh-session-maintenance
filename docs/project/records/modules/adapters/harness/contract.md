---
id: IF-harness-adapter
kind: interface
title: 平台读取、格式转换与续接合同
status: current
summary: Engine 经共享 DTO 调各项平台能力，接口种类与权限不混写。
sources:
- path: ../../packages/contracts/src/adapters.ts
- path: ../../packages/contracts/src/adapter-sdk.ts
- path: ../adapters/contract.md
- path: ../../packages/contracts/src/native-session-space.ts
- path: ../../packages/contracts/src/continuations.ts
---

# 平台读取、格式转换与续接合同

Engine 向来源读取器交付实例和会话键，取得稳定观察；向 DSH codec 交付 Canonical、受控投影读写器和环境，取得物化、规范化追加及证据；续接服务向 Codex 端口交付固定材料和目标，取得新任务及核验结果。

| 技术边界 | 唯一权威定义 | 实现/消费者 |
| --- | --- | --- |
| SessionReadAdapter | [共享 Adapter 类型](../../../../../../packages/contracts/src/adapters.ts) | CodexReadAdapter / DshReadAdapter → 导入 |
| DshSessionAdapterV1 / RuntimeBridge | [共享 Adapter 类型](../../../../../../packages/contracts/src/adapters.ts)、[SDK DTO](../../../../../../packages/contracts/src/adapter-sdk.ts)；说明 [contract v1](../../../../../adapters/contract.md) | DSH 格式族 → Lifecycle/Broker |
| NativeSessionCodec | [原生文件合同](../../../../../../packages/contracts/src/native-session-space.ts) | 持久空间发布与恢复 |
| CodexContinuationPort | [续接类型](../../../../../../packages/contracts/src/continuations.ts) | CodexContinuationAdapter → ContinuationService |

SDK 说明是人读入口，精确可选方法以 contracts 为准。旧 PlatformWriteAdapter/Gateway 仍有定义，适用边界见 [[INT-harness-directory]]，不替代当前运行追加链。

DSH codec 不打开 Maintenance SQLite、不读 Codex Home、不选择逻辑身份或全局墓碑。Codex 读取归独立只读 Adapter。探针失败/语义不明须拒绝或保留证据，不改版本字符串强行兼容；格式不兼容时换 Adapter ID 并复核字段。

[[MOD-canonical]]、[[MOD-runtime]]、[[MOD-continuation]]、[[MOD-graph]]、[[MOD-native-context]] 只消费需要的能力，已知实现和证据见 [[INT-harness-directory]]。

## Harness 与插件扩展分别适配

Harness Adapter 适配宿主实例的会话迁移、格式和生命周期。插件新增持久化事件、检查点或重放字段，不自动构成一个新 Harness；应先构建 [[IF-extension]] 的扩展数据 Adapter，再由宿主格式组合受信的扩展解析能力。

只有宿主本身的原生格式族或生命周期发生不兼容变化，才评估新的 Harness 身份。插件 namespace、schema、版本、能力和事件所有权独立声明；不能把工具测试通过当成职责分类已经正确。

GPT 当前实现见 [[INT-gpt-format]]，原来的“插件新增事件必须创建独立 Harness Adapter”规则已撤销。误解与纠正保留在 [[HIST-gpt-extension-boundary]]。
