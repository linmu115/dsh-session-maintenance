# P24：可追溯交接上下文

## 结果

- 新增独立 `handoff-context` 深 Module，统一生成预览和不可变 bundle。
- 支持完整历史、从 checkpoint 序列开始、结构化摘要，以及两条分支分区交接。
- token 估算采用保守的 UTF-8 三字节/Token 上界；超限完整模式返回 `HANDOFF_BUDGET_EXCEEDED`，不静默截断。
- 结构化摘要只做确定性选取和明确省略说明，不调用模型；完整历史仍由内容对象 ID 可追溯。
- 每条普通消息保留来源 event anchor；DSH 工具事件显式标注为导入记录，不能被解释为当前 Codex 工具执行。
- 两父来源保持两个独立分区，必须包含用户合并说明，不制造虚假的时间连续性。

## 验证

- `pnpm vitest run packages/handoff-context/test/handoff.test.ts`：1 个表驱动测试通过。
- `pnpm --filter @linmu/dsh-session-handoff-context typecheck`：通过。
- 测试覆盖预算拒绝、显式摘要、checkpoint、来源锚点、工具降格和两父分区。
