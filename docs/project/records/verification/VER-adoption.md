---
id: VER-adoption
kind: verification
title: 本次地图整理的验证范围
status: current
summary: 仅检查资料绑定、记录关系、图源与导出；历史插件测试没有在本轮重跑。
relations:
- relation: verifies
  to:
    record_id: IMP-current
---

# 本次地图整理的验证范围

本次检查对象是地图资产：精确标题绑定能否解析、记录 ID 与本地关系是否有效、跨地图 ID 能否定位、Archify 图源能否原生交付，以及 HTTP 阅读入口是否可用。

已有产品回归、真实副本安装与宿主探针保留在各自原报告。本次未操作真实 Codex/DSH Home、Vault、会话对象或模型请求，没有把地图验证当成产品重新验收。

具体本次结果见项目 docs/changes/2026-09-16-project-map-adoption.md。
