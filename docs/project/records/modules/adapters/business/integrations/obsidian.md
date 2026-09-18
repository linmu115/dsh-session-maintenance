---
id: INT-obsidian
kind: implementation
title: Obsidian：链接与引用分别接入
status: current
summary: 导航链接只保存定位，引用材料通过 Core 及受控来源能力。
relations:
- relation: consumes
  to:
    record_id: IF-instance-workspace-scope
  reason: 共享实例同步范围与未同步状态
- relation: consumes
  to:
    record_id: IF-vault-binding
    project_id: dd46311f-d98d-49ff-ae13-fef0a8a6f9c3
  reason: 计划通过提供方确认绑定并保存维护登记
- relation: consumes
  to:
    record_id: IF-extension
  reason: obsidian-links 对象及所属会话目录
- relation: related_to
  to:
    project_id: dd46311f-d98d-49ff-ae13-fef0a8a6f9c3
  reason: Suite 保存笔记侧接入与 Core 消费说明
sources:
- path: ../../packages/contracts/src/session-knowledge.ts
- path: ../../apps/engine/src/session-knowledge-service.ts
- path: ../../apps/engine/src/extensions/adapters.ts
---

# Obsidian：链接与引用分别接入

obsidian-links schema 2 用 logicalSessionId 明确所有者；schema 1 的多目标不猜归属。Maintenance 保存链接和定位，Vault 持有笔记正文。

关联笔记用于双向导航，引用到会话才进入 Core 引用事务及轻量镜像。安装 Adapter 不向每轮模型输入全部笔记，链接对象也不是完整历史快照。

合同 [知识链接 DTO](../../../../../../../packages/contracts/src/session-knowledge.ts)；实现 [知识领域服务](../../../../../../../apps/engine/src/session-knowledge-service.ts)、[obsidianLinksAdapter](../../../../../../../apps/engine/src/extensions/adapters.ts)。公共 [[IF-extension]]，Core 交接 [[INT-annotation]]。外部领取/回链/内嵌路由由 Suite 地图保留；本轮未核验真实 Vault。

## Vault 绑定及公开栏目接入（待实现）

绑定提供方为独立 Suite 的 IF-vault-binding，具体权责见 [Bridge 设计](../../../../../../../../dsh-obsidian-session-reference-suite/docs/2026-09-18-vault-instance-binding-design.md)。本项目通过 [[IF-extension-pages]] 承载管理页，通过 [[IF-instance-workspace-scope]] 返回绑定实例的有效范围。所有 Vault 共用实例选择，取消同步保留链接并提示原因；改绑不迁移历史。
