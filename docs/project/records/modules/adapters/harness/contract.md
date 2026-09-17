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

## 插件扩展会话格式：先构建 Adapter

插件若新增持久化事件、检查点、重放字段或改变已有事件语义，接入 Maintenance 前必须先实现独立 Harness Adapter。只使用既有业务对象 namespace 的插件仍走业务扩展合同，不因此新建会话格式。

- 分配独立 Adapter ID 与 NativeSessionCodec formatId，声明宿主、插件版本和可验证能力。
- 在自己的 codec 中解析和校验事件，保留不透明字段、事件序号与引用。必要事件不得删去或标记 ignorable 以绕过验证。
- 实现并验证物化、规范化追加、原生文件往返、持久恢复和证据读取；可复用已验证的底层机制，但不能全局替换普通 Adapter 的事件词表或依赖。
- Engine 按实例/profile 的实际插件构成、探针及构件回执选择 Adapter；运行、恢复与 Core 绑定使用同一身份。发布包必须包含其 worker。
- 验证插件开启/关闭、普通 Adapter 隔离、未知版本、损坏数据、跨事件引用和进程恢复。历史格式由数据所属 Adapter 处理，模型热切换不改变持久格式。

当前实例见 [[INT-gpt-format]]。更改绑定身份会改变持久空间键，需要正式修复接入；不能直接覆盖运行中的回执。
