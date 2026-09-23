---
id: MOD-business-pages
kind: module
title: 插件贡献页面与扩展目录
status: current
summary: 依据插件实际注册的页面、namespace 和提供者建立目录，界面不臆造插件栏目。
sources:
  - {role: implementation, workspace_id: source, path: apps/engine/src/business-pages.ts}
  - {role: frontend, workspace_id: source, path: apps/dashboard/src/extension-business-directory.tsx}
---
插件或业务提供者通过注册信息声明扩展数据与可选信息页面；Maintenance 汇总、按提供者身份展示，并保留数据目录与页面能力的独立性。公共 API 存在不代表每个插件都有信息页。插件内部导航与同步导航分别遵守 [[REQ-sync-extension-navigation]]；具体数据恢复见 [[MOD-plugin-adapters]]。
