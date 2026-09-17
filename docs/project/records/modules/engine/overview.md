---
id: MOD-engine
kind: module
title: Engine：编排与持久事实
status: current
summary: Engine 组合真源、运行、续接、扩展领域和查询；共享 DTO 只在 contracts。
sources:
- path: ../../apps/engine/src/composition-root.ts
- path: ../../apps/engine/src/engine.ts
---

# Engine：编排与持久事实

Engine 把平台观察、宿主追加及业务意图转成持久事实，控制身份、版本、写入序列、回执与恢复。Dashboard 和宿主使用限定 API，Adapter 不直接操作数据库。

| 子模块 | 责任 |
| --- | --- |
| [[MOD-canonical]] | 导入、规范版本与来源权 |
| [[MOD-runtime]] | 租约、准备、追加、关闭与恢复 |
| [[MOD-continuation]] | 固定来源版本的 Codex 续接作业 |
| [[MOD-extension-store]] | 业务对象、冲突与所属会话目录 |
| [[MOD-graph]] | 固定引用、主干领域事务及撤销 |
| [[MOD-native-context]] | 窗口、保留、释放意图及证据核验 |
| [[MOD-reader]] | 有界阅读与稳定请求索引 |

[组合根](../../../../../apps/engine/src/composition-root.ts)与[SessionMaintenanceEngine](../../../../../apps/engine/src/engine.ts)分别构造平台 AdapterRegistry 和 ExtensionDataService。同一个加载位置不意味着它们是一种合同。平台分支 [[MOD-harness]]，业务分支 [[MOD-business]]；宿主 [[MOD-host]]，界面 [[MOD-dashboard]]。
