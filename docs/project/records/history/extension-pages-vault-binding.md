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
coverage_note: 当前 Codex 任务公开来源第 9–259 行；只索引公开事件，末尾一个工具调用的返回不在范围内，不作为检查成功证据。文档验证另见 VER-extension-pages-design。
history:
  path: history/20260918-vault-binding-requirements
  sha256: 501c03390e67199271aa48d396a36db737ca1346e80887036745873bf812f53d
  capture_sha256: 4c9ab0529c2b8e078f9d665fd49d0c6148e26aed3426593d726618db4a9839cd
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
