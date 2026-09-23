---
id: ISS-remaining-coupling
kind: issue
issue_type: scope-conflict
issue_state: confirmed
discovered_by: llm
discovery_method: 本次重建项目地图时核对 composition-root 的具体导入与装配
scope: [MOD-core, MOD-endpoint, MOD-dsh-host, MOD-plugin-adapters]
title: 装配根仍含宿主与插件具体依赖
status: current
summary: 规范包与端点协调已抽象，但 Engine composition-root 仍直接 import DSH、Launcher、Lynn 和 GPT；全局解耦不得标完成。
sources:
  - role: evidence
    workspace_id: source
    path: apps/engine/src/composition-root.ts
  - role: evidence
    workspace_id: source
    path: apps/engine/src/integrations/launcher-discovery.ts
---
当前 `composition-root.ts` 直接引入 DSH 版本适配、DSH 宿主集成、Launcher 发现与安装选项、Lynn 和 GPT 的具体代码，并在启动时选择/附加它们。这是明确的装配依赖，不应掩盖为“Maintenance 整体已完全不耦合”。规范存储与端点协调器已依赖通用 DTO/端口，但应用层装配还未从具体平台和插件选择中拆出。

后续重构应使宿主与插件的注册/装配进入独立 adapter 启动包，让不带任何具体插件的 Engine 仅依赖通用合同；保留现有安装与兼容路径直到消费者迁移、测试和真实实例回执确认。此条记录只是代码与目标的差异，不表示本次地图任务已修改产品代码。
