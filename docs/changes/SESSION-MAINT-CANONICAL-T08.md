# T08 Adapter Host 与 Registry 变更报告

## 范围

- 新增独立的 Adapter Host 包，以逐行 JSON typed RPC 启动 Node 子进程 Adapter。
- 新增 Adapter Registry，统一登记 npm、本地目录和 Generation 来源。
- 将 Registry 接入 Engine composition root，并提供只读查询接口 `GET /v1/adapters/registry`。
- 本任务不读取或写入真实 Codex、DSH Home；验证仅使用临时 SQLite fixture 和 fake worker。

## 行为变化

- Adapter 每次探测均在独立 worker 生命周期中运行；worker 抛错、退出、超时或返回无效 DTO 时，Host 返回 `failed` 探测结果，不把异常传播到 Engine。
- Registry 的选择顺序为：手动 pinned、`verified`、`compatible`、`experimental`。普通 DSH semver 范围不作为硬性禁用条件，实际能力探测结果才决定是否可选。
- 每次探测写入 `adapter_verification_runs`；最终选择会在同一 verification run 中补充选择理由，包含 experimental 被手动固定的情况。
- Adapter 注册信息持久写入 `adapter_registry`，来源位置保留 npm、本地目录或 Generation 身份。

## 聚焦断点验证

执行：

```text
pnpm exec vitest run packages/adapter-host/test/host.test.ts apps/engine/test/adapter-registry.test.ts
```

结果：2 个测试文件、2 个关键测试全部通过。

- verified Adapter 在未固定时被默认选择。
- experimental Adapter 可被手动固定，选择理由持久化为 `pinned`。
- 模拟子进程崩溃被记录为 `ADAPTER_PROCESS_FAILED`，Engine 仍继续选择健康 Adapter。
- Engine API 可列出 npm、本地目录和 Generation 三种来源，查询过程不会加载 Adapter 代码。

补充边界检查：

```text
pnpm --filter @linmu/dsh-session-adapter-host typecheck
pnpm --filter @linmu/dsh-session-maintenance-engine typecheck
git diff --check
```

以上均通过。按照高效断点策略，本任务没有扩大到全仓测试；若后续真实 Adapter 进程在 RPC、超时或退出区间失败，再只对该区间添加更细诊断与回归用例。
