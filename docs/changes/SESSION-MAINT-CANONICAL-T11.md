# T11 Alpha2 增量规范提交变更报告

## 范围

- `ProjectionLifecycle.append` 成为 Alpha2 运行时增量写入的唯一编排入口。
- 新增 run-scoped、按 `operationId` 索引的持久 WAL；WAL 位于 Maintenance runtime，不进入 Launcher Profile 或 DSH Home。
- Alpha2 Runtime Bridge 负责原生 revision、连续事件序号和临时投影更新，平台格式知识没有进入 Canonical Engine。
- Canonical Engine 通过窄 `DshAppendCommitter` port 接收归一化事件；规范版本、operation receipt 和 projection revision 分层提交。
- Runtime Bridge 的 run-bound handler 可把 Alpha2 原生追加直接送入当前活动生命周期，不暴露 Maintenance 数据库或投影根。

## P4 固定状态断点

每次真实提交只记录：

```text
session.append.commit:started
session.append.commit:succeeded | failed
```

日志包含 runId、logicalSessionId、nativeSessionId 和 operationId，不包含会话正文。无效 revision 在写 WAL 前失败；Maintenance 暂时不可用则记录 `MAINTENANCE_APPEND_FAILED`，WAL 保持 `pending`。

## 顺序与恢复语义

1. 校验活动 run、目标会话、native revision 和 Alpha2 连续 seq。
2. 同步持久化 pending WAL。
3. 原子替换本次 run 的临时 projection session。
4. Alpha2 Codec 执行 `normalizeAppend`。
5. Canonical Engine 用同一 operationId 提交规范版本。
6. 持久化 committed receipt、推进 projection revision，并把 WAL 标记 committed。

若步骤 5 暂时失败，步骤 2–3 的状态会保留；重试看到 `projectionApplied: true` 后不会重复追加临时事件。若 receipt 已写而 projection revision 尚未推进，重放会先收敛 projection mapping 和 WAL，再返回原 receipt。已 committed 的 operationId 不再进入 Canonical Engine。

## 聚焦验证

```text
pnpm exec vitest run packages/projection-lifecycle/test/append.test.ts tests/integration/alpha2-projection-append.test.ts
pnpm exec vitest run packages/adapter-dsh-alpha2/test/runtime-bridge.test.ts packages/projection-lifecycle/test/open-run.test.ts tests/integration/alpha2-projection-open.test.ts
```

验证覆盖：

- revision/seq 错误在 WAL 前被拒绝；
- Maintenance 不可用时 WAL pending、临时投影保留且 P4 failed 可查询；
- 恢复后 user/assistant 事件进入一个新规范版本；
- Runtime Bridge handler 与直接 replay 使用同一 operationId，不产生重复版本；
- T10 的 P1–P3、Alpha2 Runtime Bridge 和投影打开行为未回归。

相关包 TypeScript 检查与 `git diff --check` 通过。没有运行全仓测试，没有读写真实 Codex 或 DSH Home；全部文件系统测试使用带标记的临时目录。
