---
id: INT-harness-directory
kind: implementation
title: 平台 Adapter 已知实现与调用者
status: current
summary: 源码注册、兼容证据与当前运行启用分别解释。
sources:
- path: ../../apps/engine/src/composition-root.ts
- path: ../adapters/compatibility-matrix.md
- path: ../../packages/adapter-dsh-0-1-5/COMPATIBILITY.md
- path: ../../apps/engine/src/external-lifecycle-provider.ts
- path: ../adapters/testing-guide.md
---

# 平台 Adapter 已知实现与调用者

| 实现 | 使用者 | 依据与限制 |
| --- | --- | --- |
| CodexReadAdapter / DshReadAdapter | Engine 扫描导入 | 组合根构造；只读来源 |
| dsh-0.1.5 | Lifecycle/Broker、图截止、原生证据 | 当前 0.1.5-rc.2 精确契约 |
| dsh-gpt-compat | Lifecycle/Broker、原生证据与 Core 格式绑定 | 插件专属事件，详见 [[INT-gpt-format]] |
| dsh-alpha2 / dsh-rc1 / dsh-rc2 | AdapterRegistry 的候选 | 源码内置注册为 enabled，运行仍需选择/探针 |
| CodexContinuationAdapter | ContinuationService | 独立端口，显式创建新任务 |
| DshWriteAdapter | 有 Gateway targets 的旧写组合 | 仍有实现，不是当前原生追加路径 |

[组合/注册调用点](../../../../../../apps/engine/src/composition-root.ts)、[历史矩阵](../../../../../adapters/compatibility-matrix.md)、[当前格式证据](../../../../../../packages/adapter-dsh-0-1-5/COMPATIBILITY.md)共同核对。

旧矩阵的 RC2 指 0.1.1-rc.2；当前 0.1.5-rc.2 用 dsh-0.1.5。旧 Provider 仅接受 Alpha2/RC1 的文字是旧范围，当前 [Provider](../../../../../../apps/engine/src/external-lifecycle-provider.ts)与 README 优先。保留历史版本，不以同名 RC2 混用。

本轮适配器、核心绑定与接入的合成测试通过；未更换运行实例。已知实现不表示所有目标都支持；新作者测试入口 [合成测试指南](../../../../../adapters/testing-guide.md)。
