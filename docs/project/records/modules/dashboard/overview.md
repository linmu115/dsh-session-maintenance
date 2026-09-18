---
id: MOD-dashboard
kind: module
title: Dashboard：阅读与维护入口
status: current
summary: 看板通过 Engine API 读取和提交维护意图，不直接访问会话库。
relations:
- relation: consumes
  to:
    record_id: IF-extension-pages
  reason: 按插件归类的结构化信息页与动作回执；与同插件扩展数据并列
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

## 业务扩展信息页（已接入，限定真实UI已验收）

[[REQ-extension-pages]] 要求公开插件栏目注册。Dashboard 按 [[IF-extension-pages]] 装载页面，提供标准目录与局部失败状态；绑定、状态和同步栏目由业务扩展贡献。绑定目录属于实例级信息，不强塞入所属会话树；实例可用范围统一消费 [[IF-instance-workspace-scope]]。

当前运行范围服务见 [[MOD-instance-workspace]]；公开信息页与贡献者生命周期见 [[MOD-business-pages]]。实现和最终验证边界分别见 [[IMP-scope-business-pages]]、[[VER-scope-business-pages]]。

2026-09-18 已实现“扩展 → 每个已登记业务插件/Adapter → 插件内页面”。Obsidian 系列内“扩展数据”和“插件信息与接入”是同级视图，不再让全局插件信息与所有扩展数据并列。分类主要消费注册元数据，旧 obsidian-bridge 到 obsidian-series 的兼容关联独立明示；信息页和数据操作各保留自身 owner/权限，切换保留尚未确认的 operationId。

同步使用同级的“Maintenance 工作区同步”和“Codex 项目同步”子栏目，各管自己的名单；访问后保持挂载，来回切换保留草稿和搜索，不自动保存。Maintenance 选择逻辑分类工作区及未分组会话，不按 DSH 的文件夹项目解释。实现、限定浏览器验收与 .39待激活边界见 [[REQ-sync-extension-navigation]]、[[IMP-sync-ui-release]]、[[VER-sync-ui-release]]。
