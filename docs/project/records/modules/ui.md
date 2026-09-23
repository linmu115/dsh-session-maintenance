---
id: MOD-ui
kind: module
title: Maintenance 看板和 DSH 入口
status: current
summary: Dashboard 展示会话、同步范围、状态和扩展数据；DSH 插件提供工作区加入及启动看板入口。
sources:
  - role: implementation
    workspace_id: source
    path: apps/dashboard/src/app.tsx
  - role: implementation
    workspace_id: source
    path: plugins/dsh-session-maintenance/src/client/dashboard-entry.ts
  - role: implementation
    workspace_id: source
    path: apps/engine/src/http/routes.ts
---
Dashboard 通过 Engine 的本地 API 读取静态会话、维护选择、同步进度及扩展栏目，不直接操作数据库或宿主会话文件。DSH 客户端从设置/侧栏打开本机看板，并提供工作区加入维护和会话变化上报入口；具体 WebUI 是宿主接入的一部分。

“加入维护”后的选择状态应与 Maintenance 看板一致，保存同步选择不应等待长时间的宿主对齐完成。页面上的状态要区别已保存范围、正在对齐、阻塞与实际运行期回传成功。UI 交互需要浏览器验收；源码和后端测试不能代替。
