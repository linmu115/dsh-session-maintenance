---
id: HIST-extension-pages-vault-binding
kind: history
title: 公开业务栏目与实例同步范围的确认
date: 2026-09-18
status: current
modules: [业务扩展, Dashboard, 宿主接入]
outcome: 已整理公开扩展与有效范围设计，尚未实施产品改动
summary: 用户将统一目录扩展为插件自主信息页，确认共享实例同步范围及未同步链接保留。
applicability: Maintenance 公开业务扩展和 Obsidian 可选接入，沿用当前数据与写入归属。
coverage_note: 当前 Codex 任务公开来源第 9–409 行，包含前次确认和后续完整文档请求；92 个公开事件且工具均配对，原 9–259 行索引保留。后续桥插件职责建议不视为确认需求。
history:
  path: history/20260918-vault-binding-complete-requirements
  sha256: bb9906b563fd63d91a996ce00869196166f348400f8c5de3e2971188b46d45d0
  capture_sha256: c698def16030cf7b4a0ad026c5493d12fd4e33d96d7025af784c804cd24b8bf1
related_records: [REQ-extension-pages, IF-extension-pages, IF-instance-workspace-scope, VER-extension-pages-design]
---

# 公开业务栏目与实例同步范围的确认

用户最初希望在扩展数据中管理实例与 Vault 绑定，并要求 Maintenance 与双侧插件可以分别安装。进一步批注明确信息页由各业务插件通过公开注册接口贡献，数据目录只是其中一个栏目。绑定能力由 Bridge 提供，Maintenance 保存维护登记并承载可选 UI。

[查看依据：初始目标](history-event:EVT-81d07c27242839b95925)

[查看依据：公开注册、栏目和独立运行要求](history-event:EVT-a6b6fe6fa122edaa171e)

对于不同实例可能选择不同工作区，用户确认同实例的各 Vault 共用全部同步范围；取消同步只提示当前实例未同步并保留链接。重新同步按原身份核验恢复，实际删除另行表示。

[查看依据：范围选择](history-event:EVT-a193f84726285801f6dd)

[查看依据：取消同步后的链接](history-event:EVT-faf13702b32783bc1295)

源码核查发现现有数据 Adapter 的注册基础和面板分组可以复用，但 extensionConnect 是完整名单上报；因此公共注册器须汇总各插件贡献，不能让一个插件的注册撤销其他插件。公开页面贡献与受信 Engine 数据 Adapter 的具体宿主不同，跨进程资源装载留在实施阶段确定。

用户后续要求整理需求和项目地图，并再次认可历史链接规则。形成 [[REQ-extension-pages]]、[[IF-extension-pages]] 与 [[IF-instance-workspace-scope]]；Bridge 的绑定与动态端口合同在 Suite 地图维护，双方只保留所消费接口。

[查看依据：整理授权与历史规则确认](history-event:EVT-55e4c3bcb5375635db5b)

本次没有定位并验证实际运行组合中“按实例勾选”的权威范围入口；历史 Codex 回写配置不等于该接口。这一项被记录为工程核查，不能声称新范围接口已经存在或另建竞争名单。文档验证与未执行的产品验收见 [[VER-extension-pages-design]]。

## 完整需求阅读入口

用户后续要求统一整理完整需求，并另行讨论 Core 与桥插件的组合。完整稿由 Suite 地图维护为跨项目入口，本项目通过已有设计和地图链接过去，继续拥有自己的公开扩展与实例范围合同。桥插件的合并建议尚未确认，不改变 Maintenance 独立安装和可选接入要求。

[查看依据：完整文档与架构提问](history-event:EVT-1ff80cd98322df6cdb24)

本次更新同一任务的公开来源范围，保留原索引；产品代码没有因本次文档同步发生改变。
