# P25：Continuation 作业与平台绑定

## 结果

- 新增 schema 4 `continuation_jobs`，持久化不可变请求 hash、交接对象、状态、Codex thread/turn ID 和验证结果。
- 新增 `ContinuationService` 深 Module；preview/create/get/recover 共用同一套目标预设、预算和幂等语义。
- target preset 从 Engine 私有配置解析 Codex instance、cwd、workspace roots、模型、权限和上下文预算；外部请求只提交 preset ID。
- 相同来源版本、目标和模式只创建一个作业；正常重试和验证恢复不会再次调用 `thread/start`。
- app-server 返回 thread ID 后立即持久化为 `started`；验证中断进入 `manual-review`，重启后调用 `recover` 继续 `thread/read`。
- 验证要求任务持久化、history mode 正确且至少有一个已落盘 turn；空任务不会被误判为完成。
- 完成后只登记 Codex 平台 binding，并把来源版本作为 `lastCommonVersionId`；不写 Codex 数据文件，也不移动原分支。
- continuation handoff 对象已纳入 GC 可达集合。

## 数据库升级

- schema 2 会依次升级到 3、4；重复打开不会重复迁移。
- 高于 schema 4 的数据库继续失败关闭。

## 验证

- `pnpm vitest run tests/integration/phase-3-continuation.test.ts packages/session-store/test/repository.test.ts`：4 个测试通过。
- contracts、adapter、store、continuation-engine、app engine 定向 typecheck：通过。
- 集成测试注入首次验证失败，再以新的 Service 实例恢复；`thread/start` 总计只调用一次。

## 已知极小窗口

Codex `thread/start` 目前不接受调用方指定的 thread ID。如果 Codex 已创建任务、但 app-server 响应尚未到达时进程被强制终止，系统无法凭空获知该空任务 ID。收到响应并执行 `onThreadStarted` 后的所有状态都可恢复。该协议限制不会导致已有 Codex 历史被改写；最坏结果是留下一个空的新任务，后续可由用户清理。
