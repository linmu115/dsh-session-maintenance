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

## 接入兼容机制修正

用户确认后，接入判断改用包内协议、宿主、格式和能力声明，旧版本表冻结至 .35。安装校验与注册复用检查入口；诊断区分未安装、未启用和不兼容。Engine .58 / 接入 .36 已通过真实注册、启动、DAG 保存/刷新和正常停止；继续安装 Bridge 后，因教程缺少已注册实例更新复核闭环而停止，详见 docs/changes/2026-09-20-plugin-compatibility.md。

## 最新交接方向

Maintenance 的普通插件组合门禁与未知类型保留登记为后续事项，暂停实现；用户要求转为关闭引擎的其他插件独立验收。此前对普通插件变化要求手工 revalidate 的建议已被替代。详见 docs/handoffs/2026-09-20-maintenance-and-independent-acceptance.md 及对应 issues 文档。

2026-09-21 更新：上段的「普通插件组合门禁暂停实现」已由用户授权开始并完成第一项，见 [[IMP-startup-gate-split]] 与 [[VER-startup-gate-split]]（未提交、未发布、未做真实实例验收）。未知类型保留（MNT-002）仍待审计。同一轮用户提出实例先启动、引擎后接管的覆盖式同步要求，登记为 [[REQ-detached-instance-attach-sync]]，尚未实现。
