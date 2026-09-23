---
id: REQ-learning-roundtrip
kind: requirement
title: 实验性学习会话双端交接与受控回收
status: current
summary: 仅显式绑定的学习会话可在 DSH 与现有 Codex 任务间交接；回收只接收边界后的新增问答，冲突拒绝自动拼接。
relations:
  - relation: depends_on
    to: {record_id: OBJ-session}
    reason: 固定逻辑会话和双端身份
  - relation: depends_on
    to: {record_id: MOD-continuation}
    reason: Codex 端定向注入与回执
---
独立实验栏目只列经用户确认的双端绑定；一个逻辑会话对应一个当前 DSH 端点和一个 Codex 任务，不按标题猜测匹配。加入后排除普通 Codex 镜像，保留 Maintenance 的完整主线、稳定锚点及插件附属数据。同步到 Codex 只送学习问答和实际引用快照；插件图、贴纸、Obsidian 关系、工具执行和内部推理不进入普通问答。用户授权图片过滤，但其他材料不得静默丢弃。

每次交接固定 DSH 修订、Codex 边界、绑定代次和成功回执。只有 DSH 学习正文未推进、Codex 新增为边界后的完整问答、无正在生成的尾部且旧注入不被误认为新回答时，才允许回收；提交前再次核对两端。空增量不新建版本，重复点击不重放，冲突保留原内容并明确阻断。迁移或端点变化使旧回执失效。真实模型问答往返与跨实例重新关联须单独验收，不能由历史合成测试推断完成。

代码入口：[[MOD-learning]]、[[MOD-continuation]]。详细历史验收条件保留在 `d3fdbe3:docs/project/records/requirement/learning-roundtrip.md`，源报告 `docs/reports/2026-09-19-learning-prefix-and-sync.md`。
