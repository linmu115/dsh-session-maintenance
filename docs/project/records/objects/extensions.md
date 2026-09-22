---
id: OBJ-extension
kind: object
title: 扩展对象、所属会话与写入权
status: current
summary: 对象按 namespace 独立版本化；引用来源不是所有者。
sources:
- path: ../../packages/contracts/src/extension-data.ts
- path: ../../packages/contracts/src/extension-directory.ts
---

# 扩展对象、所属会话与写入权

2026-09-22 用户修正：插件数据在 Maintenance 中忠实保存，目标恢复由对应插件 adapter 完成并验证功能可用。核心不拥有通用图业务模型。下表“Engine 图领域事务”是尚未迁完的遗留实现，不能当作当前职责要求；新协议与源码验证见[宿主写入与插件映射](../../../changes/2026-09-22-host-write-barrier-and-plugin-mapping.md)。

对象由 `(instanceId, profileId, namespace, objectId)` 定位。首次登记的 writerId 持有写入权；编辑带 expectedRevision，Engine 生成 revision。schemaVersion、对象修订、会话版本和插件版本各有含义。

references 可关联多个逻辑会话。所属会话由 Adapter 从明确字段解释，禁止取 references 第一项。X → Y 引用归 Y；主干归 ownerSessionId，披露日志以 graphObjectId 附属于主干。未知旧归属保留待核验。

| 数据 | 真源与写入责任 |
| --- | --- |
| 通用插件对象 | Engine 扩展库按 writer、schema、能力及预期修订保存 |
| 受管理主干 | Engine 图领域事务；浏览器未确认编辑只是候选 |
| Core 实时引用事务 | 外部 Core；annotation-records 仅为有界只读镜像 |
| Obsidian 笔记正文 | 外部 Vault；Maintenance 保存链接和有限摘录 |
| 原生上下文 | Engine 存意图和状态；DSH 日志存实际替代事实 |

唯一类型见 [扩展数据](../../../../packages/contracts/src/extension-data.ts)、[所属会话目录](../../../../packages/contracts/src/extension-directory.ts)；接入协议 [[IF-extension]]。停用和卸载不删除对象。
