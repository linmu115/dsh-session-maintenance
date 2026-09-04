# T13 投影关闭与异常恢复变更报告

## 范围

- `closeRun` 实现 drain、pending WAL 重放、最终投影检查、关闭 Checkpoint、Runtime detach、投影清理和 writer lease 释放。
- `recover(runId)` 可在原 Lifecycle 已丢失后，通过持久 run、projection mapping、manifest、recovery descriptor 和 WAL 重建恢复上下文。
- Alpha2 Runtime Bridge 一进入 drain 就拒绝新 append；Engine 仍可直接按 operationId 重放已持久 WAL。
- 插件 projection overlay 记录 draining 状态，为后续真实 sessionPersistence 写入口保留同一阻断语义。
- SQLite projection repository 支持枚举 run mappings、关联 close Checkpoint。

## P8 固定状态断点

正常关闭或异常恢复各只记录：

```text
run.shutdown-recovery:started
run.shutdown-recovery:succeeded | failed
```

P8 不记录会话正文、WAL payload 或 endpoint。普通关闭失败进入 `recovery-required`；无法解析的 WAL/恢复材料进入 `quarantined`；已经 detach 但目录清理失败进入 `cleanup-pending`，不会伪报 CLOSED。

## 正常关闭顺序

1. run 转入 `draining`，Runtime Bridge 停止接收新 append。
2. 两次 drain 之间按 operationId 重放全部 pending WAL，并确认 runtime/WAL pending 都为零。
3. 重新 inspect 当前 projection，核对会话、工作区、事件封套和最终 catalog/session digest。
4. 持久保存并关联 close Checkpoint；缺少 Checkpoint store 或 run 关联能力时停止关闭。
5. detach Runtime Bridge，删除整个 run-scoped 临时目录（projection、manifest、WAL、recovery descriptor）。
6. run 转为 `closed`，活动 writer lease 随状态释放。

## 异常恢复顺序

- 从 Maintenance runtime 读取 run-scoped recovery descriptor，不从 Launcher Profile 或 DSH Home 找会话。
- 由 projection mapping 还原 native/logical 对应关系，并从 Canonical source 获取标题、标签、工作区和 authority。
- 重新 attach Adapter Runtime，仅重放 `state: pending` 的 WAL；committed operationId 不重复提交。
- 最终核验、Checkpoint、detach、清理后 run 转为 `recovered`。

## 聚焦验证

```text
pnpm exec vitest run packages/projection-lifecycle/test/close-recovery.test.ts tests/integration/projection-recovery.test.ts
```

验证覆盖：正常关闭清空临时投影；Maintenance 中断后 pending WAL 恢复；原 Lifecycle 丢失后的冷恢复；Checkpoint 与 run 关联；P8 可查询；Runtime drain 后拒绝新写入。随后只运行 P1–P5、P8 直接相关回归和相关包 TypeScript 检查，不运行全仓测试。

全部文件系统场景使用带标记临时目录，没有读取或写入真实 Codex、DSH、Launcher Home。
