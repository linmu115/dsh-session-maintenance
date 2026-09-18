---
id: HIST-extension-pages-vault-binding
kind: history
title: 公开业务栏目与实例同步范围的确认
date: 2026-09-18
status: current
modules: [业务扩展, Dashboard, 宿主接入]
outcome: 已授权施工，桥整合首阶段本地验收通过；新增 Maintenance 实例同步范围，后续绑定与扩展接入进行中
summary: 用户将统一目录扩展为插件自主信息页，确认共享实例同步范围及未同步链接保留。
applicability: Maintenance 公开业务扩展和 Obsidian 可选接入，沿用当前数据与写入归属。
coverage_note: 2026-09-18 主代理整理当前任务公开来源第 9–1260 行，共 302 事件；含开工授权、新增实例同步策略及首阶段验收，截点处有一条工具调用尚未配对。旧索引保留，不收录隐藏推理。
history:
  path: history/20260918-phase1-construction
  sha256: 984f7df50d63c185a4eca66ed750295bece71a9723dbdb174868810e3f45968b
  capture_sha256: 5aa1bdeaf9b714e4b0d18c8b9f93032ef95f69282b4cb18dcbeb6544c3dc6d9d
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

## 桥公共能力收敛与实施顺序确认

用户明确笔记关联是普通贴纸业务，应继续保留；Bridge 暴露共用双向引用通道，由普通贴纸适配。用户同时确认纯笔记操作不必经过 Core 引用流程或 Maintenance。此前迁移笔记关联功能的建议撤回。

[查看依据：职责修正、分期及等待开工要求](history-event:EVT-7001997878bc8d33bea6)

顺序确定为先整合 DSH Bridge 和普通贴纸的已有接入，再在两侧 Bridge 实现 Vault 绑定与路由，之后新增 Maintenance 的业务 Adapter 和扩展信息页，未来专门操作通道最后再展开。新追问确认第一阶段只统一已有引用、回链、定位和解除能力，保留扩展位置。

[查看依据：第一阶段只整合现有能力](history-event:EVT-adbd0f0aa425de5f0771)

现有 Maintenance 贴纸、引用和会话定位接入必须在重构阶段保持可用，新 Adapter 后置不等于移除旧能力。先落实实施计划，只有用户明确下令后才开始产品代码施工；本次只修订文档与地图。

[查看依据：保留现有维护接入](history-event:EVT-fd7a27be9c986eb9d8e3)

## 开工、第一阶段验收与新增同步策略

用户明确下令按需求和执行规划开始施工，由主代理指挥 Astra 子代理，思考强度不超过 high。此前等待开工的约束已经满足，不能继续作为停工条件。

[查看依据：明确开工与代理配置](history-event:EVT-a4b93285e8682a319461)

施工核查发现当前源码没有每 DSH 目标实例的工作区选择，只有全部投影及独立的 Codex 来源名单。用户明确授权 Maintenance 新增自己的实例工作区会话同步选择，只有选中内容在 DSH 与真源间双向同步。它成为有效范围权威来源，Bridge 不另建名单。

[查看依据：新增每实例双向同步范围](history-event:EVT-7c5cd785972fbe658088)

首阶段将引用接入整合进 Bridge，普通贴纸保留关联业务并使用共享通道。聚焦修复独立 Sticker 可选服务访问和共享队列的跨 Profile 重试容量；Core 仍负责事务与补偿。桥、贴纸、兼容入口、Suite 和 Companion 相关本地测试通过，组合来源检查发现并修正了旧开发依赖，未部署真实应用。

[查看依据：首阶段验收与进入后续阶段](history-event:EVT-a059a28e5421ba36e9f7)
