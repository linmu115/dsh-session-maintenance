---
id: MOD-harness-dsh
kind: module
title: DSH：读取与原生格式族
status: current
summary: 当前 0.1.5 与旧 Alpha2、RC1、早期 RC2 保留独立格式及证据。
relations:
- relation: consumes
  to:
    record_id: IF-harness-adapter
  reason: 实现 DSH 读取与格式 codec
sources:
- path: ../../packages/adapter-dsh-0-1-5/COMPATIBILITY.md
- path: ../../packages/adapter-dsh-0-1-5/src/index.ts
---

# DSH：读取与原生格式族

DshReadAdapter 负责来源观察；原生 codec 实现 probe、materialize、normalizeAppend、inspect/verify、resolveReference 及持久空间/恢复/证据所需可选能力。

当前 dsh-0.1.5 对应 DSH 0.1.5-rc.2 V3，使用官方迁移与 source-coordinate 映射，记录 conversionLedger。头字段和附件有证据才保留，不从真实 Home 猜回。未知坐标、冲突、未来格式或无法证明的转换明确拒绝。

Codex portable 路径与 DSH source-owner export 分开，MCSF 统一语义，原生重放细节属 Adapter evidence，codec 不重写 Canonical 版本。

当前 [精确兼容证据](../../../../../../packages/adapter-dsh-0-1-5/COMPATIBILITY.md)、[V3 Adapter](../../../../../../packages/adapter-dsh-0-1-5/src/index.ts)；旧矩阵见 [[INT-harness-directory]]。宿主 persistence attach 属于 [[MOD-host]]，合同 [[IF-harness-adapter]]。

GPT 插件的字段由扩展数据 Adapter 解释，见 [[INT-gpt-format]]；受信 codec 与 DSH framing 组合，宿主身份保持 dsh-0.1.5。
