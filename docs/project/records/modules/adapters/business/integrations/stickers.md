---
{
  "id": "INT-stickers",
  "kind": "implementation",
  "title": "贴纸：对象、会话与引用接入",
  "status": "current",
  "summary": "贴纸对象、真实会话和固定引用分开保存。",
  "relations": [
    {
      "relation": "consumes",
      "to": {
        "record_id": "IF-extension"
      },
      "reason": "stickers 格式及受控存储"
    },
    {
      "relation": "consumes",
      "to": {
        "record_id": "IF-graph"
      },
      "reason": "会话身份、来源标记及统一撤销"
    },
    {
      "relation": "related_to",
      "to": {
        "project_id": "ed61ceeb-b51e-5124-924f-27d608ccbe10"
      },
      "reason": "按当前独立维护职责接入 Sticker Board"
    }
  ],
  "sources": [
    {
      "path": "../../apps/engine/src/extensions/adapters.ts"
    },
    {
      "path": "../../packages/contracts/src/session-knowledge.ts"
    },
    {
      "path": "../reports/2026-09-15-graph-reference-lifecycle-release.md"
    }
  ]
}
---

# 贴纸：对象、会话与引用接入

stickers Adapter 校验 schema 1，并由 logicalSessionId 明确归属。普通贴纸、独立会话入口、迁移回执分别展示，迁移回执只读。对象保存消费 [[IF-extension]]，会话身份/来源标记/撤销使用 [[IF-graph]] 的对应能力。

红色普通贴纸与蓝色跨会话引用号分别维护。删除一条蓝标经统一撤销，不删除真实会话或同选区其它引用。独立贴纸 Y 归 Y，X 只是来源。

本仓依据 [stickerAdapter](../../../../../../../apps/engine/src/extensions/adapters.ts)、[贴纸与链接 DTO](../../../../../../../packages/contracts/src/session-knowledge.ts)、[生命周期历史交付](../../../../../../reports/2026-09-15-graph-reference-lifecycle-release.md)。本轮核对本仓合同与交付记录；外部当前每个调用点、迁移细节在 Suite 消费地图维护，不展开完整内部图。返回 [[INT-business-directory]]。
