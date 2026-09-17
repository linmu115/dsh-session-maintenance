---
id: MOD-business
kind: module
title: 业务插件／扩展数据适配器
status: current
summary: 解释业务 schema、归属、面板和能力，不处理平台原生会话格式。
relations:
- relation: implements
  to:
    record_id: REQ-adapter-families
sources:
- path: ../../apps/engine/src/extensions/adapters.ts
- path: ../../apps/engine/src/composition-root.ts
---

# 业务插件／扩展数据适配器

ExtensionDataAdapter 声明 namespace、支持插件/schema 版本、校验、摘要和能力，必要时提供 ownership 与预览；数据由 [扩展存储、冲突与目录](../../engine/extensions/overview.md) 保存。

可信 Engine 代码通过 register 或 CompositionOptions.extensionAdapters 注册，disposer 只卸载能力。实例/Profile 的 extensionPlugins 是本实例参与者的完整声明，和代码注册表分开；不接受浏览器上传执行代码。

合同 [对象合同](contract.md)；已知目录 [业务已知接入](connected.md)；具体接入 [Core 的固定引用、镜像与原生接入](integrations/annotation.md)、[贴纸：对象、会话与引用接入](integrations/stickers.md)、[ThoughtDAG：主干领域与上下文视图](integrations/thoughtdag.md)、[Obsidian：链接与引用分别接入](integrations/obsidian.md)。

Obsidian 系列面板聚合多个 namespace，ThoughtDAG 聚合主干与附属日志；面板数量不等于平台 Adapter 数。另一责任分支 [平台适配](../harness/overview.md) 不共享业务写权限。
