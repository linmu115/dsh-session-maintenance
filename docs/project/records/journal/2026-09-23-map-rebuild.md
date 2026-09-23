---
id: JRN-20260923-map-rebuild
kind: journal
title: 依当前代码重建 Maintenance 地图
status: current
date: 2026-09-23
summary: 保留项目身份和有效需求，重建整体图、流程图及源码模块图，并保存旧资产逐条去向。
relations:
  - relation: verifies
    to: {record_id: VER-map-rebuild}
    reason: 本次地图交付检查
---
用户要求按更新后的项目地图 skill 和现有代码重构，旧图与陈旧记录从当前树移除，提交并推送。第一步保留项目 ID，建立 19 条当前简图。随后按新版完整交付规则，在修改前保存当前与旧版本清单，重新核对旧需求、决定、接口、对象、模块、约定、术语和问题；有效内容重写进当前地图，撤销项与时点历史有明确去向。

本次新增 Archify 主要流程图，扩展责任图，绑定并运行 GitNexus 对 577 个生产源码文件的静态分析；更新项目说明、源码入口与三图关联。结构及机械检查已通过，浏览器内验证节点到说明的实际跳转和模块调用详情。相关证据与限制在 [[VER-map-rebuild]]；任务过程记录见 [2026-09-23 地图重建](../../history-drafts/2026-09-23-map-rebuild.md)。地图修改不涉及产品代码、Launcher 或真实实例。
