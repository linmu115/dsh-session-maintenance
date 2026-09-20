---
{
  "id": "IMP-independent-components-20260920",
  "kind": "implementation",
  "title": "Maintenance 独立组件升级候选",
  "status": "current",
  "summary": "引擎独立、宿主格式检查迁入 adapter 包、同包双入口、统一业务 SDK 与目录、镜像默认关闭、无 Launcher CLI、受管启动/失联门禁。 候选未安装。",
  "sources": [
    {
      "path": "../changes/2026-09-20-independent-components.md"
    },
    {
      "path": "../../docs/deployment/independent-components.md"
    }
  ]
}
---

# Maintenance 独立组件升级候选

引擎独立、宿主格式检查迁入 adapter 包、同包双入口、统一业务 SDK 与目录、镜像默认关闭、无 Launcher CLI、受管启动/失联门禁。

本记录说明本轮源码状态；历史部署/验证不自动成为本轮证据。[[IMP-independent-components-20260920]] 的实现细节和限制见绑定变更文档，最终验证见交付报告。


## DAG 依赖边界修复（本轮后续）

本轮新增：thoughtdag 可选 adapter 将真源中的旧主干转换到统一会话数据，支持新格式往返并保留原件。部署停在 .35 未被接入检测白名单识别，未启动 DSH，未通过真实页面验收。详见 docs/changes/2026-09-20-dag-session-data.md。
