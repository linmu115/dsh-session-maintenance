# P15：官方 DSH 写入契约门禁

## 结果

P15 在第一步安全门禁停止。官方 DSH `0.1.1-rc.2` 没有提供能把已落盘会话恢复到“写入前状态”的公共服务，因此 Maintenance 不会实现 `create-session`、`append-events`、`update-title` 或 `update-archive`，也不会绕过服务直接修改 `.jsonl.zstd`、`workspace.json` 或 projection cache。

## 已固定的官方契约

- `@deepseek-ai/dsh-session-persistence@0.1.1-rc.2`
  - npm integrity：`sha512-dxdYxRfmK5jWtiFFabqRNb/jGGjkXyF2djI7O8IIKmDVjhQiv170zpvhbAhRUuqClEdseCtbQpLBrRm2blzt3g==`
  - 公开方法包含 `create`、`append`、`inspect`、`load`、`readFrom`、`readRaw` 和 listing。
  - 不包含 `remove`、`forget`、任意版本 truncate/replace 或 restore。
- `@deepseek-ai/dsh-workspace@0.1.1-rc.2`
  - npm integrity：`sha512-jBUob4H5TZAiExq9YNVCglKAFmAKMtd1UbyqFfnZZ1Owm+3c3NbAXY947MHiD6NwCwFEW1y7FjrFj66UQvG90A==`
  - 官方 surface 有 `archiveSession`，没有 `unarchiveSession`。
- session format version：`0`。
- 锁定指纹：`dsh-write/0.1.1-rc.2/session-v0:2c1456d8a5a834badd6dfd603adce2cfbbae6afdd4e5413e898c78c5a0dcb8f0`。

官方仓库中也已有相同缺口的讨论：[`sessionPersistence: no delete/forget API`](https://github.com/deepseek-ai/deepseek-harness/discussions/4411)。讨论指出直接删文件会与运行中索引失步并可能被重新写回，因此不能把外部文件删除当作 restore。

## 新增实现

- 新增 `@linmu/dsh-adapter-dsh-write` 的契约评估层；当前没有 `PlatformWriteAdapter` 实例。
- 新增可迁移的合成契约 fixture，不复制用户会话或官方源码。
- 精确契约返回 `degraded`，只声明只读 `verify`；全部 mutation 能力附带明确禁用原因。
- 任意一字段漂移返回 `unsupported` + `ADAPTER_INCOMPATIBLE` + 零 mutation capability。

## 本机漂移发现

本机 runtime 中的 `@deepseek-ai/dsh-workspace/lib/index.js` 包含 `dsh-desktop patch (session manage)` 和额外 `unarchiveSession`，但同目录类型声明仍没有该方法；从 npm 重新下载的官方 `0.1.1-rc.2` 也没有该实现，两份 JS 哈希不同。该本地补丁不属于可迁移的官方 DSH 契约，运行时探测会把它视为 drift 并拒绝写入。

## 为什么不能继续 P15/P16

`create` 或 `append` 在崩溃前可能已经持久化完整前缀。没有官方 remove/truncate/replace 时，事务引擎只能看见“既不是目标状态，也不是备份状态”的第三状态，无法完整 restore。继续实现只能选择直接改文件，而这会绕过 DSH 内存索引、write-behind、workspace 和 projection 生命周期，正是计划明确禁止的 fallback。

重新开放写入至少需要官方 core 同时提供：

1. 按 session ID 串行化的 remove/forget 或原子 replace/truncate；
2. 拒绝 live session 的 busy 语义；
3. workspace/archive 与 projection cache 的对应 forget/逆操作；
4. 可在 public read interface 上验证 absent/previous state 的完成条件。

## 验证

- 先运行缺失模块测试，确认红灯。
- `pnpm --filter @linmu/dsh-adapter-dsh-write typecheck`：通过。
- `pnpm vitest run packages/adapter-dsh-write/test/contract.test.ts`：3 个测试通过。
- 测试覆盖固定指纹、portable fixture 一致性和单字段漂移零写能力。
- 没有读取任何会话正文，没有修改正式 DSH home。
