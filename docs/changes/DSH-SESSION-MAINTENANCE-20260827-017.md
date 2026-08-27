# P15B：通过可恢复 Core Gateway 写入 DSH

## 结果

完成 `DshWriteAdapter → DshHostGateway → DshCoreExtension` 写链，并接入 P14 的 `TransactionBackupStore` 与故障恢复。Adapter 不再声明“官方公开服务可逆”，而是只在 exact rc.2 Core 契约、host 物化门禁和事务 scope 同时成立时开放六项写能力。

## Gateway 与物化门禁

- Gateway token 使用 HMAC-SHA256，短期有效并绑定 `{transactionId, planHash, instanceId, sessionId}`；snapshot 不能跨 instance/session scope。
- 每次 capture/apply/observe/restore 都重新检查 Core 契约与 host materialization，payload 上限为 64 MiB。
- Core package build gate 固定并验证：
  - `src/rc2-host.ts`：`sha256:d5e0b4bcc630e50c7c31bd6a06a5aaac16cb0d0024e3743bcc0a60bb86bbd4cd`
  - `dist/rc2-host.js`：`sha256:87ae13c49c7cb06eac44f676033e168efc2e3c118eae4d46896c55ce4d44ec15`
- 开发模式同时检查当前 source 与已构建 artifact；打包模式检查 tarball 中实际加载的 artifact。
- `pnpm pack` 的真实 tarball 包含 Core contract、extension、host、materialization 及声明文件；解包后 `probeBuiltRc2CoreHost()` 返回 `compatible` 和上述两个 hash。

## Adapter 事务语义

- `prepare` 在任何 Core capture 前加载并验证 immutable source，拒绝 metadata、tool-import、attachment、system/unknown role、孤立 assistant、review/destructive 或重复 operation。
- canonical `dsh-prepared.json` 带自身 hash，先记录 intent；backup 捕获后只记录 snapshot 的 content-addressed entry，不复制 artifact 到 prepared descriptor。
- 唯一 required backup 名为 `dsh-core-snapshot`。commit 与 restore 都只能通过 `TransactionBackupStore.get()` 做 size/SHA-256 验证后读取。
- DSH user/assistant 导入生成连续 seq 的 `turn/start → step/start → message(s) → step/end → turn/end`；message ID 由 plan/event 稳定派生，assistant 保留 provider/model provenance。
- title 使用独立 `session/title` 用户重命名事件；archive 通过 Core workspace operation；create session ID 由 logical session 与 plan hash 确定性生成。
- commit receipt 保存 Core state digest；verify 再次 observe Core。P16 仍会用正常 DSH read Adapter 做更高层的 normalized session 验证后才移动 refs。

## 故障恢复验证

focused test 在官方形状的合成 host 中准备一组 user/assistant strict-prefix 事件，并在 session artifact 已追加后立刻抛错：

1. P14 在 commit-started 后识别异常；
2. Adapter 从 required backup 解析并校验同一 Core snapshot；
3. Gateway 使用新的事务 scope token 调用 restore；
4. session、workspace、projection、coordinator、query 五个 domain digest 全部回到写前；
5. transaction 状态为 `restored`，没有重复 restore。

## 验证

- 红灯：新增 Adapter recovery test 首次因 `@linmu/dsh-host-gateway` 不存在而失败。
- `pnpm vitest run packages/dsh-core-extension/test packages/adapter-dsh-write/test packages/transaction-engine/test --maxWorkers=4`：10 个文件、23 个测试通过。
- 全 workspace `pnpm typecheck`：通过。
- 全 workspace `pnpm build`：通过；Core source/artifact materialization gate 通过。
- Core `pnpm pack`、tarball 文件清单、解包 artifact hash 与 runtime materialization probe：通过。
- `git diff --check`：通过。

## 数据安全

所有写入均发生在随机临时 Maintenance root、内存合成 Core host 和 marked synthetic DSH identity。没有读取用户会话正文，没有修改或启动正式 Codex/DSH home。
