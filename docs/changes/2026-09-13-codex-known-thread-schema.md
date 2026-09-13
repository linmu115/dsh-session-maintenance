# 2026-09-13：兼容已核查的 Codex threads 加列结构

## 问题与结果

在 Launcher 启动 RC2 副本的准备阶段，Maintenance 导入已配置的 Codex 来源时返回 `Codex read contract is not compatible: codex-main`，导致该次启动准备失败。

只读检查数据库表定义后，确认当前 Codex `state_5.sqlite` 的 `threads` 表保留原有全部 38 列的顺序、类型、可空性和主键定义，只在末尾追加 `originator TEXT` 与 `daybreak_enabled BOOLEAN` 两个可空、非主键字段。此前 Adapter 要求完整列定义与原 38 列契约完全相等，因此拒绝了该已核查的 40 列结构。

本次修复让 Codex Read Adapter 明确接受两种完整契约：原 38 列结构，以及按上述顺序追加两列的 40 列结构。两者仍逐列、逐类型、逐约束、按顺序精确匹配。原结构继续报告原有 `schema-3` 指纹；40 列结构报告独立的 `schema-4` 指纹。

## 范围

- 只修改 `packages/adapter-codex-read` 的 schema probe 与回归测试。
- 原有平台版本限制保持 `0.146.0`。
- 不放宽任意新增列、部分新增列、错误类型、错误可空性、缺列或不同列顺序。
- 不读取新增字段值，也不改变会话目录查询、消息归一化或来源归属。
- 不绕过启动前的来源校验，不改变 Engine 启动同步策略。

## 验证

使用带标记的合成测试目录，覆盖两种已知结构的 probe、目录读取和会话归一化，并验证有项目范围的 probe 不读取任何 rollout 正文。

拒绝用例覆盖：只出现一个新增字段、新增字段错误类型、原有字段错误类型、错误可空性、新增列顺序改变、原有字段缺失，以及已知两列之外再追加未知字段。这些用例均要求在读取 rollout 正文前拒绝。

已执行 `pnpm --filter @linmu/dsh-adapter-codex-read typecheck` 和 `pnpm exec vitest run packages/adapter-codex-read/test`；类型检查通过，6 个测试文件的 58 项用例全部通过。真实来源调查仅执行只读 schema probe 和 `PRAGMA table_info(threads)`，未打开会话正文或凭据，未对真实 Codex Home 执行写操作。

本报告记录有界 schema 兼容修复，不声称该修复已完成 Launcher 实例启动验收；最终 Engine 打包、提交和实例验证由本次发布流程继续执行。
