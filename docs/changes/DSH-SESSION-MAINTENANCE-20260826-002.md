# P2：共享契约与运行时 Schema

## 目标

把阶段一跨包 DTO、只读适配器/仓储接口、计划、作业、本机 API 响应和错误模型集中到 `@linmu/dsh-session-contracts`，并用严格 Zod schema 固定运行时边界。

## 修改文件

- 类型与接口：`src/model.ts`、`src/adapters.ts`、`src/store.ts`、`src/plans.ts`、`src/jobs.ts`、`src/http.ts`
- 校验与错误：`src/schemas.ts`、`src/errors.ts`
- 聚合导出：`src/index.ts`
- 包依赖：`package.json`、根 `pnpm-lock.yaml`
- 测试：`test/contracts.test.ts`

## 公开导出

- 常量：`CONTRACT_SCHEMA_VERSION`、`SESSION_MAINTENANCE_ERROR_CODES`。
- 基础模型：`JsonValue`、平台/兼容/绑定/会话状态联合类型，以及 `PlatformSessionKey`、`RegisteredInstance`、`NormalizedEvent`、`NormalizedSession`、`SessionVersionManifest`、`LogicalSession`、`PlatformBinding`、`MatchCandidate`、`Checkpoint`、`VersionGraphData`、观察结果、分页、差异和 Engine 状态 DTO。
- 服务接口：`SessionReadAdapter`、`ReadOnlyEngine`、`SessionRepository`、`ContentObjectStore`。
- 计划：`BindingSnapshot`、`ConfirmationRequirement`、`PlannedOperation`、`ScanRequest`、`DiffRequest`、`PlanRequest`、`SyncPlan`。
- 作业：`JobStatus`、`JobRef`、`JobEventBase`、`JobEvent`。
- HTTP：`ApiErrorBody`、`ApiErrorResponse`、`EngineStatusResponse`、`SessionListResponse`、`VersionGraphResponse`、`PlanResponse`、`JobAcceptedResponse`。
- 错误：`SessionMaintenanceErrorCode`、`SessionMaintenanceError`。
- 运行时 schema：上述全部可序列化 DTO 对应的严格 `*Schema` 导出，以及通用 `jsonValueSchema` 和 `pageSchema()`。

## 关键决策

- 运行时平台枚举只有 `codex | dsh`，不保留 EAC 或旧同步器兼容字段。
- `RegisteredInstance.root` 只存在于 Engine 内部契约；对外 HTTP 请求只接受已登记 ID，严格对象会拒绝 `root`、`path`、`cwd` 等额外字段。
- 版本 manifest 的父节点由运行时 schema 限制为最多两个；阶段一领域层仍不会主动生成两父版本。
- `SourceAnchor` 与 `Provenance` 分开：事件锚点不携带扫描时间，采集时间只属于会话/版本来源。
- 全部错误使用固定错误码；未知码不能构造 `SessionMaintenanceError`。

## 测试与结果

- `pnpm vitest run packages/contracts/test/contracts.test.ts`（实现前）：3 个测试失败，缺少 schema 导出，符合红测预期。
- `pnpm vitest run packages/contracts/test/contracts.test.ts`：3 个测试通过；覆盖未知平台、三父版本、路径注入、完整会话/计划和五种作业事件往返。
- `pnpm --filter @linmu/dsh-session-contracts typecheck`：通过。
- `pnpm check`：2 个测试文件、4 个测试全部通过，typecheck/build 通过。
- `git diff --check`：通过。

## 遗留风险

- 本阶段只固定读模型与 dry-run 计划契约；HTTP 路由、存储和适配器实现将在后续批次完成。
- Zod 负责运行时父节点数量限制，TypeScript 的只读数组类型本身不能表达“最多两个”。
