# 会话上下文关系图：需求文档交付

日期：2026-09-10。状态：文档交付，功能实现待后续任务。

## 问题与结果

选区引用、贴纸、会话和 Obsidian 双链需要共同组织讨论来源，并允许 AI 查询有明确截止位置的上游。直接拼接完整历史会放大上下文，因此本次将讨论整理为按需工具读取的功能规格和跨仓库改动清单。

交付：

- [设计和功能需求](../superpowers/specs/2026-09-10-session-context-graph-requirements.md)：确定会话贴纸、跨会话选择流程、回复完成位置截止、后端读取/检索、容量限制、数据归属、可拔插性、空间策略及 AC01–AC22 验收。
- [插件与引擎改动清单](../superpowers/specs/2026-09-10-session-context-graph-plugin-changes.md)：区分两个维护项目，列出 Annotation Core、Sidechat、Session Maintenance、Sticker Board、Obsidian Bridge、ThoughtDAG 和部署引擎的职责及现有代码入口。
- 原扩展数据需求新增关联入口，保持原有持久会话空间规格独立。

## 基线与依据

文档分支从 `5fd467922dcc8ccda0f8d740fecd3811dc6ef2fb` 建立。该基线已包含持久原生会话空间实现提交，但本次没有验证安装运行状态。

核查其它仓库的现有源文件，确认划选浮窗位于 Sidechat，统一引用能力位于 Annotation Core；会话真源与查询属于 Session Maintenance 仓库内的 Engine，独立 Maintenance Engine 负责部署。借鉴本机 Codex 已核查的任务引用/分页读取机制，并注明其不能保证任意长结果绝不超限。

## 验证

提交前的文档检查：

- 4 份变更文档中的 8 个相对链接可解析，3 个 Mermaid 代码块围栏完整。
- D、XR、CUT、ST、OB、GR、RD 和 AC 各组编号完整且唯一；AC01–AC22 的跨文档引用有效。
- 对照记录的提交核对主要插件、维护仓库和独立部署引擎的文件入口；划选入口与核心能力的职责没有混用。
- `git diff --cached --check` 通过，暂存差异仅含本次 4 份 Markdown 文档。

没有可执行代码变更，不新增行为测试或运行插件构建；规格中的自动与手工验收均留给未来实现。

## 范围

仅文档。未修改插件运行代码、既有会话、Vault 正文、实例配置或安装包；未部署 ThoughtDAG，未实施全局维护网络。
