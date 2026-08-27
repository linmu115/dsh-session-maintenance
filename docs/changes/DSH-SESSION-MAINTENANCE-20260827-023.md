# P23：Codex 原生任务创建契约

## 结果

- 新增独立 `adapter-codex-continuation` Module，生产实现只调用 Codex app-server v2，不读取或写入 Codex rollout、索引或 SQLite。
- 锁定 Codex CLI `0.146.0`，契约为 `initialize -> thread/start -> turn/start -> thread/read` 与 `turn/completed`。
- 新任务固定 `ephemeral: false`、`historyMode: paginated`，因此属于可持久化、可恢复的原生 Codex task。
- 版本漂移或初始化失败时 capability 为空；在 thread 已创建后失败的错误保留 `threadId`，供后续作业进入人工复核而不是静默删除。

## Interface

- `CodexContinuationAdapter.probe`
- `CodexContinuationAdapter.create`
- `CodexContinuationAdapter.verify`
- `AppServerTransport` 是生产 stdio 和测试内存实现的真实 seam。

## 验证

- `pnpm vitest run packages/adapter-codex-continuation/test/contract.test.ts`：3 个测试通过。
- `pnpm --filter @linmu/dsh-adapter-codex-continuation typecheck`：通过。
- 测试只使用脚本化 transport，没有创建真实 Codex 任务。
