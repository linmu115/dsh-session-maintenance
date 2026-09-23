---
id: IMP-current-source
kind: implementation
title: 当前源码的可用链路与限制
status: current
summary: 依据 2026-09-23 当前提交 d3fdbe3 的代码核对，记录真源、同步、宿主写回、插件映射和看板入口。
progress: implemented
relations:
  - relation: implements
    to:
      record_id: REQ-sync-coverage
    reason: 代码具备对齐和运行期变化路径，但真实实例完整验收另行确认
  - relation: implements
    to:
      record_id: REQ-opaque-mapping
    reason: 代码保存并恢复带来源的插件原数据
sources:
  - role: implementation
    workspace_id: source
    path: apps/engine/src/composition-root.ts
  - role: implementation
    workspace_id: source
    path: apps/engine/src/endpoint-sync.ts
  - role: implementation
    workspace_id: source
    path: packages/instance-integration-dsh/src/host-workspace-sync.ts
  - role: implementation
    workspace_id: source
    path: packages/adapter-lynn/src/runtime.ts
---
当前 Engine 组合规范存储、会话读写、端点同步和 HTTP API。DSH 端点对齐通过 `synchronizeThroughHost` 向实际宿主提交完整投影；运行期 `HostSessionSync` 观察持久化和归档状态并上报。Lynn / GPT 适配器处理各自数据。看板从 Engine API 展示静态会话和同步状态，DSH 客户端具有启动看板入口。

源码包清单：Engine `0.1.43-rc2.95`、Dashboard `0.1.20`、DSH 接入插件 `0.2.27-rc2.79`。这是源码清单，不是已安装或在线实例版本；旧 README 的配套版本表不是本次核对依据。

限制：`apps/engine/src/composition-root.ts` 仍直接选择具体 DSH、Launcher、Lynn 和 GPT 实现，严格全局解耦未完成；Codex 工作区策略的原生写入被显式标记不可用。产品功能的真实实例 UI 和完整双向操作未在此次地图整理中重新验收，见 [[ISS-remaining-coupling]] 与 [[VER-map-rebuild]]。
