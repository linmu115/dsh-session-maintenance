# T12 Codex 延迟派生变更报告

## 范围

- Codex 会话只被读取、物化或关闭时不创建派生会话。
- 第一次 DSH 续写由 Canonical Engine 根据 source logicalSessionId 与 operationId 生成稳定 child ID；调用方不需要预建 child。
- 派生事务同时写 child session、child version、derivation、继承后的 workspace membership 和 operation receipt。
- 派生固定使用 projection 的 baseVersionId；即使 Codex 在 run 期间继续增长，child 仍从用户实际看到并续写的版本分叉。
- Alpha2 临时投影在规范事务成功后，把 logicalSessionId/baseVersionId 和运行映射切换到 child；native session ID 在当前 run 内保持不变。

## 继承和权威边界

- child 从固定 base version 继承标题、标签、归档状态和逻辑工作区。
- child 的 `authorityScope` 为 `maintenance`、`originKind` 为 `codex-derived`。
- 原 Codex 会话保持 `authorityScope: codex`、原 binding 和独立 head；Maintenance 不修改 Codex 真源。
- base 中的历史事件保持原 source logicalSessionId；第一次 DSH 新增事件重定向到 child，child version 以 base version 为 parent。
- 标题不追加派生后缀，符合已确认的继承规则。

## P5 固定状态断点

只有第一次 Codex 续写记录：

```text
session.derivation.create:started
session.derivation.create:succeeded | failed
```

P5 与同一 operationId 的 P4 并行可查询。若规范事务或 mapping switch 失败，两者分别落 terminal failure；如果 canonical receipt 已成功但 projection mapping 尚未完成，重放会执行一次受 P4/P5 记录的收敛，不重复创建 child。

## 聚焦验证

```text
pnpm exec vitest run packages/canonical-session-engine/test/derivation.test.ts tests/integration/codex-delayed-derivation.test.ts
pnpm exec vitest run packages/canonical-session-engine/test/engine.test.ts packages/projection-lifecycle/test/append.test.ts tests/integration/alpha2-projection-append.test.ts packages/adapter-dsh-alpha2/test/runtime-bridge.test.ts
```

验证覆盖：

- 只读 projection 后规范会话数量不变；
- Codex 在 run 期间增量后，source 和 child 独立前进；
- 第一次写入只产生一个确定性 child，并继承固定 base 的元数据和工作区；
- 模拟事务中断后以同一 operationId 恢复，不留下半个 child；
- Alpha2 临时 payload 与 projection mapping 都切到 child；
- T04 Engine 和 T11 WAL/append 回归共 7 项通过。

三个直接相关包的 TypeScript 检查通过。遵循断点式审查策略，未运行全仓测试；所有场景均使用内存 store 与带标记临时目录，没有访问真实 Codex 或 DSH Home。
