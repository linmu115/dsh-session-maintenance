# Phase 3 验收记录：真实 Codex 延续任务

**日期：** 2026-08-27

**综合分支：** `codex/phase-4-native-mirror`

**支持契约：** Codex CLI `0.146.0` / app-server v2

## 结论

Phase 3 已通过真实 Codex 验收。维护引擎从精确 DSH 版本创建了一个非临时、可继续的原生 Codex 任务，并通过普通 Codex 读取接口验证标题、任务 ID、分页历史、列表可见性与来源上下文。重复恢复沿用同一任务，没有创建第二份副本。

真实任务：`codex://threads/01a04361-b4cd-7f53-95f8-6f936cb430f7`

标题：`DSH Session Maintenance - Phase 3 Live Acceptance - 2026-08-27`

验收只验证“创建、持久化、读取和恢复”，没有要求模型继续处理导入内容。关闭验收用 app-server 后任务处于 `notLoaded`，但仍可从 Codex 任务系统按原 ID 读取和继续。

## 真实契约修正

Codex `0.146.0` 的分页任务拒绝 `thread/read(includeTurns=true)`。Adapter 现按真实契约执行：

1. `thread/read(includeTurns=false)` 读取并校验任务元数据；
2. `thread/resume` 物化和验证分页 turns；
3. `thread/list` 确认任务已进入普通任务目录；
4. 验证失败时保留任务 ID供恢复，不重复调用 `thread/start`。

最终只创建 1 个真实任务；`historyMode=paginated`、`ephemeral=false`、列表可见，读取和 resume 验证通过。

## 语义边界

- 普通 user/assistant 文本进入延续上下文；
- DSH 工具调用与结果以可见的 `DSH IMPORT RECORD` 降格，不伪造成 Codex 工具执行；
- 上下文保存来源 session、version hash、archive hash 与 source-event anchor；
- 两个原分支不会因双父延续而被移动或覆盖；
- Phase 3 本身不修改 Codex rollout、索引或 SQLite。

## 验证

- Phase 3 聚焦测试与 HTTP/MCP 幂等入口通过；
- 最终全量回归：66 files / 142 tests 通过；
- 真实任务可由 Codex 任务读取接口解析，标题与 ID保持一致；
- 没有创建额外真实验收任务。
