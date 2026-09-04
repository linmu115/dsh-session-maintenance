# T09 Alpha2 Engine Codec 变更报告

## 范围

- 新增 `@linmu/dsh-session-adapter-alpha2` 纯 Codec 包。
- 依据官方 npm `0.1.2-alpha.2` 的 Session、Persistence 和 JSONL 契约构造脱敏合成 fixture；没有复制、解析或写入用户会话。
- 实现 probe、规范会话物化、投影 inspect/digest verify、原生追加规范化、稳定引用解析。

## 对 Alpha2 破坏性变化的处理

- 会话头使用 Alpha2 的 `SessionHeader.version = 0`，不把 DSH semver 写成日志格式号。
- 输出事件严格使用连续 `seq`，满足 Alpha2 persistence 的追加约束。
- `user/message`、`assistant/message`、`tool/call`、`tool/result` 映射到 Alpha2 原生事件 vocabulary，并保留 surface 字段。
- 未知事件完整保留原始 envelope；inspect 报告 `ALPHA2_EVENT_HELD_OUT`，不静默丢弃，也不因普通版本范围差异禁止实验。
- 稳定逻辑会话 ID 可确定性解析为 Alpha2 native session ID，引用锚点保持不变。
- 旧 Client Runtime 不再参与 Codec；后续 Runtime Bridge 只对接 Alpha2 `sessionPersistence`。

## 聚焦断点验证

```text
pnpm exec vitest run packages/adapter-dsh-alpha2/test/core-smoke.test.ts
pnpm --filter @linmu/dsh-session-adapter-alpha2 typecheck
```

结果：单一 Core Smoke 与类型检查通过。该测试覆盖 exact-package probe、物化、摘要复核、追加规范化、未知事件 round-trip、引用解析和 Bridge 合约闭环。

Gate B 复用 T06/T08 已建立的稳定边界：Adapter Registry 可查询选择及 verification run，状态事件具备 SQLite 持久化、查询和 SSE。只重跑对应轻量断点，不扩大全仓测试。

Gate B 聚焦复跑共 4 个测试文件、7 个测试，全部通过：Alpha2 Core Smoke、Adapter Registry API、状态日志持久化和状态 SSE。

## 尚未在本任务执行

- 不向真实 Alpha2 Home 写投影。
- 不在真实 DSH 进程挂载 sessionPersistence。
- 不执行物理 JSONL/Zstandard 编码。

这些属于 T10 的 Projection Lifecycle 与 Runtime Bridge，避免把纯 Codec 验证和真实运行生命周期混为一个低效测试区间。
