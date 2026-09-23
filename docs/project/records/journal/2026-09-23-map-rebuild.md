---
id: JRN-20260923-map-rebuild
kind: journal
title: 依当前代码重建 Maintenance 地图
status: current
date: 2026-09-23
summary: 保留项目身份，删除旧地图，重新建立当前模块、接口和验收边界。
relations:
  - relation: verifies
    to:
      record_id: VER-map-rebuild
    reason: 本次地图交付的静态检查
---
用户要求按新的项目地图 skill 与现有代码重构，并删除旧地图、提交推送。地图沿用原项目 ID；把旧入口中的多时点状态压缩为当前责任地图，按规范核心、端点协调、DSH 宿主、插件适配和 UI 分层，新增三项关键接口说明与尚存装配耦合问题。旧地图可从 `d3fdbe3:docs/project/` 查回；原规格和变更报告不随之删除。

本次仅更新地图资料，不改产品代码或真实实例。静态验证见 [[VER-map-rebuild]]；任务过程草稿见 [2026-09-23 地图重建](../../history-drafts/2026-09-23-map-rebuild.md)。发行与运行验收不由这次地图检查替代。
