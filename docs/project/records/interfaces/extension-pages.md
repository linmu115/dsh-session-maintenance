---
id: IF-extension-pages
kind: interface
title: 插件贡献页面注册合同
status: current
summary: 插件声明自己提供的数据栏目及可选信息页，Maintenance 汇总注册结果但不臆造页面。
sources:
  - {role: implementation, workspace_id: source, path: apps/engine/src/business-pages.ts}
  - {role: consumer, workspace_id: source, path: apps/dashboard/src/extension-page.tsx}
---
提供者提交 namespace、标题、页面能力与可查询入口；看板按提供者身份组织子栏目。同一插件可以只提供“扩展数据”而没有信息页，数据服务和页面服务可独立注册。页面加载错误需保留明确失败与重试入口，不能以另一插件成功代替。详细旧设计绑定仍见原规格 `docs/superpowers/specs/2026-09-18-extension-pages-and-instance-scope.md`。
