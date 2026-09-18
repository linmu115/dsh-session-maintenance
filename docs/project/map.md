# Session Maintenance

## 这个项目做什么

将 Codex 与 DSH 会话维护为有稳定身份、版本、来源和恢复证据的长期资料。Engine 管规范历史及业务对象，平台 Adapter 处理宿主格式，扩展 Adapter 解释引用、贴纸、链接、主干和 GPT 插件状态。源 Codex 日志与 Vault 笔记各由原平台拥有。

本项目独立维护，ID 为 `0d05f813-7097-47d9-9e88-3d523bb537d6`。DSH–Obsidian Suite 与 ThoughtDAG 是外部协作者，各有独立地图。

## 按问题阅读

| 想了解什么 | 入口 |
| --- | --- |
| 能做什么、现在怎样用 | [当前能力](../../README.md#%E5%BD%93%E5%89%8D%E5%8A%9F%E8%83%BD)、[使用流程](../../README.md#%E4%BD%BF%E7%94%A8%E6%B5%81%E7%A8%8B)、[当前实现](records/implementation/IMP-current.md) |
| 身份、版本、真源与写入权 | [会话与工作区身份](records/objects/overview.md)、[版本与续接](records/objects/versions.md)、[对象归属与写入权](records/objects/extensions.md) |
| 内部责任及生命周期 | [Engine 编排](records/modules/engine/overview.md)、[宿主接入](records/modules/host/overview.md)、[维护看板](records/modules/dashboard/overview.md) |
| 接 Codex/DSH 平台 | [平台适配](records/modules/adapters/harness/overview.md) → [平台合同](records/modules/adapters/harness/contract.md) → [平台已知接入](records/modules/adapters/harness/connected.md) |
| 接业务插件 | [业务数据适配](records/modules/adapters/business/overview.md) → [对象合同](records/modules/adapters/business/contract.md) → [业务已知接入](records/modules/adapters/business/connected.md) |
| 主干、引用与释放怎样协作 | [主干与固定引用](records/modules/engine/graph/contract.md)、[原生上下文释放](records/modules/engine/native-context/contract.md) |
| GPT 插件接入与本次误解 | [[INT-gpt-format]]、[[HIST-gpt-extension-boundary]] |
| 学习会话双端交接（实验，待实现） | [[REQ-learning-roundtrip]]、[[HIST-learning-roundtrip]] |
| 业务插件信息页与实例分类工作区范围（本地实现与验证完成） | [[REQ-extension-pages]]、[[IF-extension-pages]]、[[IF-instance-workspace-scope]]；历程 [[HIST-extension-pages-vault-binding]] |
| 跨项目完整确认稿 | [DSH–Obsidian 与 Maintenance 完整需求](../../../dsh-obsidian-session-reference-suite/docs/2026-09-18-dsh-obsidian-confirmed-requirements.md)；先桥重构、再绑定路由、后新增业务 Adapter；保留现有维护接入；本地组合已验收，真实安装与窗口验收尚未进行。 |
| 旧设计哪些有效 | [规格继承](records/decision/authority-history.md) |
| 这次验证了什么 | [本次地图验证](records/verification/VER-adoption.md)；历史产品证据 [原生上下文历史验证](../changes/2026-09-15-native-context-management.md#%E9%AA%8C%E8%AF%81%E5%AF%B9%E5%BA%94)、[目录与阅读器历史验证](../reports/2026-09-15-extension-ownership-reader-release.md#%E9%AA%8C%E8%AF%81%E4%B8%8E%E9%83%A8%E7%BD%B2) |

架构图以责任边界展示内部模块与接口；流程图只画实现可证明的交接。A/B 共用本地图，B 可展开目录按责任定位记录。

## 维护约定

重启重复会话、归档还原与旧派生标题修复：[[IMP-recovery-archive]]；开发历程与来源：[[HIST-recovery-archive-title]]。

原需求、合同及交付报告保留原位置和编号。提供方技术合同只维护一份，消费者说明具体调用能力；记录和节点绑定随相关事实更新。diagrams 是原生图源，views 是带指纹的按需快照。普通维护不新增更新记录，不要求每轮读全图、重测产品或做成本基准。

## 当前实现与验收边界

[[MOD-instance-workspace]] 提供分类工作区策略、run 快照及可选 host 有效范围；配置保存后下次启动生效，当前 run 不换范围。[[MOD-business-pages]] 提供公开贡献注册、结构化栏目与持久动作回执。当前代码与版本见 [[IMP-scope-business-pages]]，分组测试及已闭合的响应丢失重试问题见 [[VER-scope-business-pages]]。旧设计与历史检查保留原时点；本轮完成本地实现、构建与合成验收，未部署真实实例。
