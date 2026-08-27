# P14：可恢复写事务、Checkpoint 与保护性回收

## 目标

在接触任何真实平台写接口之前，建立一个与平台实现解耦的事务内核，使后续 DSH 写入具备备份、确认、串行化、验证、恢复和可审计状态。

## 修改内容

- 新增 `@linmu/dsh-session-transaction-engine`：事务执行器、恢复器、fsync 哈希链 journal、内容寻址 backup、root lock、confirmation 和 named checkpoint。
- contracts 增加 write Adapter、事务、备份、恢复、Checkpoint、confirmation、HTTP response 和 repository DTO。
- SQLite schema 升级到 3，新增事务、步骤、backup manifest、confirmation nonce 与 checkpoint-backup 关联表。
- repository 将事务状态与对应步骤放入同一 SQLite 事务，并提供紧急 `manual-review` 封锁与 backup protection 查询。
- content GC 报告增加逐对象原因，区分 reachable、retention window 和 unreachable。
- fake write Adapter 加入 prepare/backup/commit/verify/restore 故障注入。

## 固定安全顺序

```text
load immutable plan
→ probe exact Adapter contract
→ re-read platform fingerprints
→ acquire registered-root lock
→ reject unresolved transaction on same root
→ persist plan and transaction
→ prepare without mutation
→ persist complete backup manifest
→ commit
→ verify
→ complete or restore once
```

显式 restore 与普通 apply 分开：调用方先按 transaction + backup hash 获取确认范围，再签发五分钟单次 token。错误范围、过期和重放都在 restore 前失败。

## 崩溃与不一致策略

- applying/verifying 的未知结果先 verify；匹配目标状态才完成，否则使用已登记 backup restore，绝不盲目重放 commit。
- 完整 journal 比 SQLite 多出的步骤可按哈希链补录；SQLite 比 journal 多或任一已提交行不一致时，事务直接标记 `manual-review`。
- 持久 owner lock 只有在原进程已不可达且 journal/SQLite 检查一致后才允许恢复流程清理；普通 apply 永不猜测并窃取旧锁。
- verify-false、commit throw、verify throw 都只触发一次 restore；restore throw 固定进入 `restore-failed`。

## Checkpoint 与 GC

- Checkpoint 是用户显式创建的具名稳定节点，不在每次 apply 时自动产生。
- Checkpoint 持有明确 refs 和已完成事务 backup ID；无法证明 backup 完整时拒绝创建。
- 未解决事务与 Checkpoint 引用的 backup 都进入保护集合。
- GC dry-run 逐项返回保留/可删除原因，便于 Dashboard 后续先预览再执行。

## 验证

- `pnpm --filter @linmu/dsh-session-transaction-engine typecheck`：通过。
- `pnpm vitest run packages/transaction-engine/test`：7 个文件、19 个测试通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `pnpm assert:portable`：通过，156 个文本文件已检查。
- `pnpm exec vitest run --maxWorkers=4`：32 个文件、82 个测试通过。既有 Codex 100-session catalog 压力用例使用 15 秒独立预算，避免扩大测试集后并发 I/O 触发默认 5 秒误报。
- `git diff --check`：通过。

## 明确未做

- 没有实现或启用真实 DSH writer。
- 没有访问正式 Codex/DSH home，没有写入真实会话。
- 没有兼容旧 `dsh-codex-session-sync` 或 EAC。
- 平台 refs 只有在 P16 的写入验证完成后才会移动。
