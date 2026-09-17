---
id: MOD-dashboard
kind: module
title: Dashboard：阅读与维护入口
status: current
summary: 看板通过 Engine API 读取和提交维护意图，不直接访问会话库。
relations:
- relation: consumes
  to:
    record_id: IF-extension
  reason: 分页目录和受限对象操作
- relation: implements
  to:
    record_id: REQ-reader
sources:
- path: ../../apps/dashboard/src/app.tsx
- path: ../../apps/dashboard/src/session-reader.tsx
- path: ../../apps/dashboard/src/extension-business-directory.tsx
- path: ../../apps/engine/src/http/server.ts
---

# Dashboard：阅读与维护入口

展示工作区/会话、版本/检查点、运行、删除恢复、集成和业务目录。DSH 停止后仍可阅读已维护的内容；[[MOD-reader]] 提供有界问答、过程与请求，[[MOD-extension-store]] 提供所属目录。

展开才加载条目/正文。镜像只读，图和原生上下文操作由对应领域能力执行。缺 Adapter、归档、冲突和停用按成员显示，不把部分可用说成全组可写。

已确认、待实现：完整看板增加“学习会话双向维护（实验）”独立栏目，仅管理确认双端关联的会话，提供同步到 Codex 与受控回收。范围及验收见 [[REQ-learning-roundtrip]]；不依赖改动 Codex 前端。

HTTP 使用回环绑定、Bearer 或 UI cookie/CSRF/Origin 校验，浏览器不读 SQLite。入口 [页面组合](../../../../../apps/dashboard/src/app.tsx)、[阅读器](../../../../../apps/dashboard/src/session-reader.tsx)、[业务目录](../../../../../apps/dashboard/src/extension-business-directory.tsx)、[HTTP 服务](../../../../../apps/engine/src/http/server.ts)。本轮仅生成项目地图阅读页，没有修改产品 Dashboard。

## 学习双向维护实验栏目

源码新增独立栏目，管理显式确认的双端绑定、同步、回收和冲突提示。入口与首版重启约束见 [[IMP-learning-roundtrip]]，真实部署状态见 [[VER-learning-roundtrip]]。
