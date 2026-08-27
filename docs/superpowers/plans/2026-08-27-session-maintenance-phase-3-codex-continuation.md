# Session Maintenance Phase 3 Codex Continuation Implementation Plan

> 执行方式：Inline Execution。每个任务完成后写一份修改记录并独立提交。

**目标：** 从任意已登记的 DSH 会话版本创建新的、可在 Codex 中原生显示和继续的任务；只使用 Codex 支持的创建入口，不修改 Codex rollout、索引或 SQLite。

**基线：** `c4fac25`。第二阶段 P15 的 DSH 写入门禁保持原状；第三阶段只读取 DSH，因此不依赖 P16–P22，可以与路线 A 并行实施。

**创建入口：** 锁定 Codex CLI `0.146.0` 的 app-server v2 契约：`initialize -> thread/start -> turn/start -> thread/read`。版本或必需方法漂移时停止创建并只生成交接包。

**测试约束：** 只保留三个高价值测试层：交接内容与预算、app-server 契约/故障状态机、隔离端到端。DTO、CLI 和 HTTP 不重复穷举同一业务分支。

## 固定边界

- 创建的是新 Codex 任务，不把 DSH 历史伪装成原生 Codex 历史。
- 普通消息保留来源锚点；DSH 工具事件折叠为“DSH 导入记录”，不伪造 Codex 工具调用。
- 完整上下文超过预算时不得静默截断。用户只能改用 checkpoint，或明确选择“结构化摘要 + 可追溯归档”。
- UI/API 只提交 `logicalSessionId`、`versionId`、`targetPresetId` 和模式，不接受任意本机路径。
- `thread/start` 成功后即使后续验证失败，也保留并登记 thread ID 为 `manual-review`，不静默删除任务。
- 相同来源版本、目标预设和交接模式重复提交必须返回同一 continuation 作业，不重复创建 Codex 任务。
- 本阶段不启用原生双向镜像，不实现 Codex 数据库写入，不等待 DSH 写入能力。

## 深 Module 与 Interface

```ts
interface HandoffBuilder {
  preview(request: HandoffRequest): Promise<HandoffPreview>;
  build(request: ConfirmedHandoffRequest): Promise<HandoffBundle>;
}

interface CodexContinuationAdapter {
  probe(target: CodexTargetPreset): Promise<ContinuationProbe>;
  create(bundle: HandoffBundle, target: CodexTargetPreset): Promise<CreatedCodexThread>;
  verify(thread: CreatedCodexThread): Promise<ContinuationVerification>;
}

interface ContinuationEngine {
  previewContinuation(request: ContinuationPreviewRequest): Promise<HandoffPreview>;
  createContinuation(request: CreateContinuationRequest): Promise<ContinuationJob>;
  getContinuation(id: string): Promise<ContinuationJob | undefined>;
  createResolutionContinuation(request: ResolutionContinuationRequest): Promise<ContinuationJob>;
}
```

`HandoffBuilder` 隐藏预算、来源和归档格式；`CodexContinuationAdapter` 隐藏 JSON-RPC、进程和 app-server 事件；Engine 只编排作业、幂等性、绑定和错误状态。

## P23：锁定 Codex 创建契约

**新增：**

- `packages/adapter-codex-continuation/`
- `fixtures/codex/0.146.0/app-server-contract.json`
- `docs/changes/DSH-SESSION-MAINTENANCE-20260827-023.md`

**实现：**

1. 定义 app-server transport seam；生产 Adapter 使用 stdio JSON-RPC，测试 Adapter 使用内存 transport。
2. 探测 CLI 版本、初始化响应和四个必需方法；计算固定契约指纹。
3. 执行 `thread/start`、`turn/start`、等待 `turn/completed`、再 `thread/read`。
4. 连接断开、版本漂移和方法缺失返回明确兼容性结果；不触碰 Codex 存储文件。

**唯一目标测试：** `adapter-codex-continuation/test/contract.test.ts` 覆盖成功、契约漂移和“创建后验证失败保留 thread ID”。

## P24：构建可追溯交接包

**新增：**

- `packages/handoff-context/`
- `docs/changes/DSH-SESSION-MAINTENANCE-20260827-024.md`

**实现：**

1. 从内容对象读取一个或两个来源版本，生成完整、checkpoint 或结构化摘要三种预览。
2. 使用保守 token 估算，输出预算占用、超限原因和可选模式；超限完整模式失败关闭。
3. 交接正文包含来源平台/session/version/hash、锚点、普通对话和折叠的 DSH 导入记录。
4. 结构化摘要保留最近对话、用户确认的合并说明和完整归档 object ID，不调用模型生成摘要。
5. bundle 写入内容寻址对象库，以 hash 作为不可变身份。

**唯一目标测试：** `handoff-context/test/handoff.test.ts` 用表驱动覆盖预算边界、来源锚点、工具降格和双父分区，不拆成重复小测试。

## P25：Continuation 作业、幂等和平台绑定

**修改：** contracts、schema migration、session-store、Engine composition。

**实现：**

1. 增加 continuation 作业表，状态为 `prepared | creating | started | verifying | completed | failed | manual-review`。
2. 作业保存 request hash、bundle object、来源版本、target preset、Codex thread ID、错误码和验证结果。
3. 通过已登记 `targetPresetId` 解析 Codex instance、cwd、workspace roots、模型和上下文预算。
4. 成功验证后把 Codex thread 绑定到原逻辑会话的新平台分支；后续普通 scan 负责观察其首个 Codex 版本。
5. 在 `started` 之后失败的作业可恢复验证；不得重复 `thread/start`。

**验证：** 扩展 P23 的状态机测试；只为 migration 增加一次 reopen 断言，不为每个字段写独立测试。

## P26：CLI、loopback API 与 Codex 插件入口

**新增/修改：**

- CLI：`continuation preview|create|status|recover`
- HTTP：预览、创建、查询、恢复验证四个受 token 保护的路由
- local API client 对应方法
- `plugins/codex-session-maintenance/`：`.codex-plugin/plugin.json`、Skill 和 stdio MCP server

**实现：**

1. Skill 负责指导用户选择 DSH 版本、预览预算和确认模式。
2. MCP 只调用 loopback Engine，提供 `continuation_preview`、`continuation_create`、`continuation_status` 和 `logical_session_open`；不读取平台文件。
3. 参数只使用 ID；Dashboard 尚未交付时返回稳定的本地详情 URL，后续直接复用。
4. 使用官方 plugin validator 校验插件结构。

**验证：** 一个 HTTP/MCP contract test 证明两种入口得到相同 job ID 和错误码；不重复测试 Engine 已覆盖的业务分支。

## P27：两父解析版本

**实现：**

1. 只有明确的 `ResolutionContinuationRequest` 可以创建两父版本。
2. 两条历史在交接包中分区展示，不按时间拼接；记录两父 ID、共同祖先、用户合并说明和来源 hash。
3. 创建的新 Codex 任务绑定到解析版本；原来的两个平台分支和 ref 保持不变。
4. 相同两父、说明、预设和模式保持幂等。

**验证：** 追加到 handoff/状态机表驱动用例，不新建第三套重复测试。

## P28：隔离验收与交付

**新增：**

- `tests/integration/phase-3-continuation.test.ts`
- `docs/validation/phase-3-validation.md`
- `docs/changes/DSH-SESSION-MAINTENANCE-20260827-028.md`

**一个端到端场景完成全部门禁：**

```text
DSH fixture version
  -> preview
  -> build immutable bundle
  -> fake app-server creates native thread
  -> verify/read
  -> persist job
  -> bind same logical session
  -> process restart
  -> recover same completed job without duplicate thread
```

另做一次只读的本机 `codex --version` 与生成契约对照；除非用户明确要求人工验收，不自动在真实 Codex home 创建测试任务。

最终只运行：

```powershell
pnpm vitest run packages/handoff-context/test/handoff.test.ts packages/adapter-codex-continuation/test/contract.test.ts tests/integration/phase-3-continuation.test.ts
pnpm typecheck
pnpm build
pnpm assert:portable
git diff --check
```

## 完成标准

- 一个 DSH 版本可以通过受支持入口创建、验证并绑定新的 Codex 原生任务。
- 超限上下文只有显式替代方案，没有静默截断。
- DSH 工具事件不被表示为原生 Codex 工具执行。
- 进程在 thread 创建后退出时能继续验证，不重复创建任务。
- 两父解析不会覆盖或伪造任一原分支。
- Codex 版本或 app-server 契约漂移时零创建并产生可导入交接包。
- Codex Skill/MCP、CLI 和 HTTP 共用同一 Engine 作业与错误语义。

