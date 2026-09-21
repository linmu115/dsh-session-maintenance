---
{
  "id": "INT-obsidian",
  "kind": "implementation",
  "title": "Obsidian：链接与引用分别接入",
  "status": "current",
  "summary": "导航链接只保存定位，引用材料通过 Core 及受控来源能力。",
  "relations": [
    {
      "relation": "consumes",
      "to": {
        "record_id": "IF-instance-workspace-scope"
      },
      "reason": "共享实例同步范围与未同步状态"
    },
    {
      "relation": "consumes",
      "to": {
        "record_id": "IF-vault-binding",
        "project_id": "e3d24f03-71bb-40ee-a66f-90e50d01f6e7"
      },
      "reason": "计划通过提供方确认绑定并保存维护登记"
    },
    {
      "relation": "consumes",
      "to": {
        "record_id": "IF-extension"
      },
      "reason": "obsidian-links 对象及所属会话目录"
    },
    {
      "relation": "related_to",
      "to": {
        "project_id": "2079793c-4a82-5c27-a71f-68084adb619e"
      },
      "reason": "按当前独立维护职责接入 Obsidian 侧 Bridge"
    }
  ],
  "sources": [
    {
      "path": "../../packages/contracts/src/session-knowledge.ts"
    },
    {
      "path": "../../apps/engine/src/session-knowledge-service.ts"
    },
    {
      "path": "../../apps/engine/src/extensions/adapters.ts"
    },
    {
      "path": "../../../dsh-obsidian-session-reference-suite/docs/2026-09-18-vault-instance-binding-design.md",
      "role": "linked-authority"
    }
  ]
}
---

# Obsidian：链接与引用分别接入

obsidian-links schema 2 用 logicalSessionId 明确所有者；schema 1 的多目标不猜归属。Maintenance 保存链接和定位，Vault 持有笔记正文。

关联笔记用于双向导航，引用到会话才进入 Core 引用事务及轻量镜像。安装 Adapter 不向每轮模型输入全部笔记，链接对象也不是完整历史快照。

合同 [知识链接 DTO](../../../../../../../packages/contracts/src/session-knowledge.ts)；实现 [知识领域服务](../../../../../../../apps/engine/src/session-knowledge-service.ts)、[obsidianLinksAdapter](../../../../../../../apps/engine/src/extensions/adapters.ts)。公共 [[IF-extension]]，Core 交接 [[INT-annotation]]。外部领取、回链和内嵌路由分别由 DSH Obsidian Bridge 与 Obsidian 侧 Bridge 地图维护；本轮未核验真实 Vault。

## Vault 绑定及公开栏目接入

桥接合同由 DSH Obsidian Bridge 的 IF-vault-binding 维护；独立维护页的授权合同见 [[IF-offline-vault-binding]]，DSH 停止时仍可管理在线 Vault。历史设计依据为，具体权责见 [Bridge 设计](../../../../../../../../dsh-obsidian-session-reference-suite/docs/2026-09-18-vault-instance-binding-design.md)。本项目通过 [[IF-extension-pages]] 承载管理页，通过 [[IF-instance-workspace-scope]] 返回绑定实例的有效范围。所有 Vault 共用实例选择，取消同步保留链接并提示原因；改绑不迁移历史。
