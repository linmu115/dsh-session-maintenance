---
id: MOD-business
kind: module
title: 业务插件／扩展数据适配器
status: current
summary: 解释插件 schema、归属、面板及扩展事件；宿主 framing 和迁移仍由 Harness 负责。
relations:
- relation: provides
  to:
    record_id: IF-extension-pages
  reason: 已实现的公开扩展贡献入口，业务数据与信息页能力独立
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

公开业务贡献由各插件注册自身能力，Maintenance汇总完整名单，单一插件不能以自己的名单撤销其他插件。数据Adapter与结构化信息页是两项独立能力：信息页动作仍交业务提供方执行，不能借页面注册取得对象写权限。Maintenance对于Core/Bridge/贴纸的运行时引用与笔记通道是可选维护能力，缺席时报告该维护服务不可用，不阻断已独立具备的业务通道。业务Adapter保存/恢复历史类型，不接管Core实时引用事务；更完整职责由外部提供方地图维护。

合同 [对象合同](contract.md)；已知目录 [业务已知接入](connected.md)；具体接入 [Core 的固定引用、镜像与原生接入](integrations/annotation.md)、[贴纸：对象、会话与引用接入](integrations/stickers.md)、[ThoughtDAG：主干领域与上下文视图](integrations/thoughtdag.md)、[Obsidian：链接与引用分别接入](integrations/obsidian.md)。

Obsidian 系列面板聚合多个 namespace，ThoughtDAG 聚合主干与附属日志；面板数量不等于平台 Adapter 数。另一责任分支 [平台适配](../harness/overview.md) 不共享业务写权限。

GPT 兼容插件是第三类面板，见 [[INT-gpt-format]]；其原生扩展事件解析与宿主 codec 组合，不新增 Harness 身份。

## 公开页面与栏目贡献（待实现）

[[REQ-extension-pages]] 与 [[IF-extension-pages]] 将业务扩展注册公开给插件，支持各自信息页和栏目；数据目录是可复用栏目。每个插件注册自己的贡献，由宿主汇总完整接入名单，避免单插件上报清掉其他参与者。当前 Engine 可信数据 Adapter 注册继续保留，页面贡献不扩大写入权限。
