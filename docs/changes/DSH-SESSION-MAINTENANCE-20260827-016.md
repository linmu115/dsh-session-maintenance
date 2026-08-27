# P15A：版本锁定的 DSH rc.2 Core 扩展

## 结果

新增 `@linmu/dsh-core-extension` 深模块，为官方 DSH `0.1.1-rc.2` 提供窄接口的 `probe/capture/apply/restore`。它把公开服务缺失的 snapshot、inverse、cache invalidation 和 query reconcile 收进一个版本锁定 host adapter，重新开放 P15/P16 的可恢复写入路线，但没有触碰正式 DSH home。

## 契约边界

- 仅支持 DSH `0.1.1-rc.2`、session v0、workspace v2、projection v3、query SQLite v8。
- 指纹包含两个已捕获官方包的版本和 npm integrity、所有实际调用的方法名，以及 session、persistence、JSONL、workspace、projection、query 六个实现文件的 SHA-256。
- exact fixture 启用 `create-session`、`append-events`、`update-title`、`update-archive`、`verify`、`restore` 六项能力。
- 任一 source hash 或 surface 漂移返回 `ADAPTER_INCOMPATIBLE`，且不会调用 host mutation。
- 当前本机含非官方 workspace patch 的旧 runtime 不属于该契约，不会被误判为可写。

## Core 深模块

- `capture` 记录会话 absence/原始 artifact、物理 revision、workspace 精确位置与 archive、projection row 和 runtime 语义摘要。
- `apply` 拒绝 live target、身份变化、snapshot 损坏、物理 revision 漂移和非连续事件；forward create/append/archive 仍走官方服务。
- `restore` 在 session 锁内按 authoritative-first 顺序恢复 artifact、清理 coordinator/preparation、恢复 workspace 和 projection，再从 persistence reconcile query index。
- 同一 session 的 apply/restore 在模块内串行，调用者不能传 artifact 路径或 shell 操作。
- 恢复 digest 比较稳定业务状态。物理 mtime/revision 与 query generation 可能因合法 restore/reconcile 改变，因此它们保留为 stale 门禁证据，不伪装成业务内容差异。

## 精简验证

- 先运行缺失 package 的 focused test，确认红灯。
- `pnpm vitest run packages/dsh-core-extension/test/core-extension.test.ts --maxWorkers=1`：2 个测试通过。
- fault 在 session mutation 后触发；显式 restore 后 session、workspace、projection、coordinator、query domain digests 全部回到写前状态。
- `pnpm --filter @linmu/dsh-core-extension typecheck`：通过。
- `pnpm --filter @linmu/dsh-session-test-support typecheck`：通过。
- 全 workspace `pnpm typecheck`、`pnpm build`：通过。
- `git diff --check`：通过。

## 数据安全

测试只使用内存合成 host 和可迁移 contract fixture。没有读取用户会话正文，没有写入、安装或启动正式 Codex/DSH profile。
