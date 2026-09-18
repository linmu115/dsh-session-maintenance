---
id: INT-business-directory
kind: implementation
title: 业务 Adapter 已知格式与接入目录
status: current
summary: 八个当前 namespace 各自管理格式、能力和归属；不是实例启用清单。
sources:
- path: ../../apps/engine/src/extensions/adapters.ts
---

# 业务 Adapter 已知格式与接入目录

[builtInExtensionAdapters](../../../../../../apps/engine/src/extensions/adapters.ts)登记如下。表中只选代表插件版本，完整 pluginVersions/schemaVersions 仍以唯一代码为准。

| namespace | 格式与所有者 | 消费说明及声明版本 | 边界 |
| --- | --- | --- | --- |
| thoughtdag | schema 1/2；ownerSessionId，日志挂图 | [[INT-thoughtdag]]；含 0.4.14-rc2.13 | 新图走领域操作，旧图待核验 |
| annotation | ReferenceSet schema 1；旧原生身份 | [[INT-annotation]]；0.3.6 | 不等于实时事务迁移 |
| annotation-records | schema 1；targetSessionId | [[INT-annotation]]；含 0.3.12-rc2.12 | 轻量镜像只读、可信同步 |
| annotation-upstream | schema 1；targetSessionId | [[INT-annotation]]；含 0.3.12-rc2.12 | 固定来源和截止 |
| annotation-context | schema 1；ownerSessionId | [[INT-annotation]]；0.3.12-rc2.11/.12 | 禁通用写，原生领域操作 |
| stickers | schema 1；logicalSessionId | [[INT-stickers]]；含 0.7.3-rc2.18 | 迁移回执只读 |
| gpt-compat | schema 1，只读来源版本摘要；ownerSessionId | [[INT-gpt-format]]；0.5.0-dev.1/.2/.3 | 原始事件随会话保存，索引不含密文 |
| obsidian-links | schema 1/2；新格式 logicalSessionId | [[INT-obsidian]]；含 0.6.4-rc2.6 | Vault 持有笔记正文 |

gpt-compat 单独显示为 GPT 兼容插件，thoughtdag 单独显示为 ThoughtDAG，其余聚合为 Obsidian 系列；各成员启用/兼容/能力仍独立。运行完整接入名单来自 extensionPlugins，显式 [] 断开全部，省略字段保持旧启动方式。

这是本仓声明与已知接入，不从包依赖推断安装和启用，不声称全局完整插件清单。外部内部架构留各自地图。

## 新公共注册接口的消费核查

[[IF-extension-pages]] 待实现后，Obsidian 系列、ThoughtDAG 及其他业务插件可维护自己的栏目。现有成员先做兼容核查，不因接口新增自动迁移全部插件；当前已启用完整名单仍不能由单个插件的小名单直接替换。
