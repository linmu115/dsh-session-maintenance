---
id: IF-endpoint-sync
kind: interface
title: 实例与真源的端点同步协议
status: current
summary: 实例报告所选会话的发现、更新、归档或删除，Engine 返回逻辑会话身份和明确处理结果。
sources:
  - role: contract
    workspace_id: source
    path: packages/contracts/src/workspace-sync.ts
  - role: implementation
    workspace_id: source
    path: apps/engine/src/endpoint-sync.ts
  - role: consumer
    workspace_id: source
    path: plugins/dsh-session-maintenance/src/host-session-sync.ts
---
实例端点先取得当前同步状态 `{epoch, phase, policyRevision}`。对齐成功进入 active 后，它携带 epoch、Profile、原生会话 ID 和 change 报告变化；change 为 discover、refresh、archive（含归档布尔值）或 delete。Engine 在同一写入协调范围里重核身份与选择范围，回执给出规范逻辑会话 ID 与 updated、deleted、out-of-scope 等结果。

例如实例新增会话时，宿主报告 discover，平台适配器读取并核对原生内容，再由真源登记逻辑会话；归档状态变化报告 archive。对齐被阻塞时只允许不覆盖现有规范会话的 discover；旧 epoch、范围版本变化和身份不符应拒绝并重读，不能默默写入。上报失败留在实例待办队列，不能当成成功。

合同只定义端点与规范真源的交接；DSH 标题、路径、序号和宿主事件如何读取由 [[MOD-dsh-host]] 与格式适配器决定。改变 DTO 或阶段语义会影响 Engine、DSH 插件和测试端点。
