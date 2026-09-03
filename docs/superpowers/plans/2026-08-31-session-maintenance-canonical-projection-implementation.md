# Session Maintenance 稳定真源与 DSH 临时投影实施计划

> 日期：2026-08-31
>
> 状态：历史计划；2026-09-03 起由 `2026-09-03-mcsf-v1-alpha2-incremental-projection-implementation.md` 取代
>
> 目标分支：codex/canonical-session-projection
>
> 规格：../specs/2026-08-31-session-maintenance-canonical-projection-design.md
>
> 执行要求：批准后使用 executing-plans 技能逐任务施工；不得跳过阶段门或把多个任务合并成一次不可审查的大改。

> 取代原因：后续已经确认只实施 Alpha2 格式族、保留本地投影，并在每次启动时按 Maintenance Revision 拉取差量；本文件中的“全量物化后删除”、RC2 和 Generation 步骤不再代表当前决定。

## 1. 目标

把当前以 native_mirrors 和各 DSH Profile Home 为中心的会话维护方式，替换为：

- Maintenance 独立稳定真源；
- Codex 独立真源和只读增量镜像；
- DSH 启动时完整物化、运行时增量回写、退出后清空的临时投影；
- Codex 会话第一次被 DSH 续写时延迟派生；
- 与 DSH 版本无关的逻辑工作区；
- 公开 Adapter SDK 和 RC2、Alpha2 两个首批 Adapter；
- 独立 Maintenance WebUI；
- 可恢复删除、Checkpoint、运行租约和状态日志；
- Launcher Profile 共享同一 Maintenance 会话真源；
- Annotation、Sticker、Obsidian 引用跨版本保持稳定定位。

## 2. 总体实施策略

施工分六批、二十个任务：

    Batch A  规范模型、存储和迁移预览           T01-T05
    Batch B  状态日志、Adapter SDK 和 Alpha2   T06-T09
    Batch C  Alpha2 投影主链                   T10-T13
    Batch D  引用、WebUI、删除和恢复           T14-T16
    Batch E  RC2、Launcher 和正式切换          T17-T19
    Batch F  最小端到端验收与 Generation       T20

每个任务：

1. 只修改明确列出的文件或同一深模块内部文件。
2. 先写一个聚焦失败测试，再实现该任务的最小能力。
3. 只运行该任务的测试和直接受影响测试。
4. 写一份 docs/changes/SESSION-MAINT-CANONICAL-TNN.md。
5. 单独提交。
6. 不在任务中运行全仓测试。

新增或移除 workspace 包时，pnpm-lock.yaml 是该任务允许的派生文件，即使没有在后续每个文件清单中重复列出。它只能包含当前任务造成的 workspace 依赖变化。

跨仓库任务必须在进入目标仓库后重新读取该仓库的 AGENTS.md、检查工作树并遵循其变更记录格式；主仓计划不能覆盖目标仓库自己的约束。

全仓 typecheck、build 和 test 只在 T20 运行一次。

## 3. 高效断点式审查策略

### 3.1 固定状态日志入口

P1-P8 是长期保留的状态日志入口：

| 断点 | 固定 stage | 首次实现任务 |
|---|---|---|
| P1 | run.lease | T10 |
| P2 | projection.materialize | T10 |
| P3 | runtime.persistence.attach | T10 |
| P4 | session.append.commit | T11 |
| P5 | session.derivation.create | T12 |
| P6 | projection.cross-version.verify | T17 |
| P7 | reference.roundtrip.verify | T14 |
| P8 | run.shutdown-recovery | T13 |

每个入口只默认记录：

- started；
- succeeded 或 failed；
- runId；
- logicalSessionId；
- nativeSessionId；
- operationId；
- adapterId；
- errorCode；
- diagnosticDetailRef；
- durationMs。

### 3.2 失败后才细分

如果某一任务失败：

1. 找到最后一个 succeeded 断点。
2. 找到第一个 failed 或缺失的下游断点。
3. 只在两者之间增加临时 child stage。
4. 只运行该区间的聚焦测试。
5. 修复后保留一个真实故障回归。
6. 删除无长期价值的高噪声 child stage。

禁止在问题尚未出现前给所有内部函数增加逐行日志。

### 3.3 审查门

每一批只设置一个主链验收门：

- Gate A：v6 合成数据库迁移预览，不修改源库。
- Gate B：Alpha2 Adapter Core Smoke 和状态事件可查询。
- Gate C：Alpha2 P1-P5、P8 主链。
- Gate D：WebUI、P7、删除与恢复。
- Gate E：RC2 P6、Launcher Profile 和迁移切换。
- Gate F：一次完整人工主链和稳定 Generation。

批次内失败只阻止后续依赖任务，不触发全仓回归。

## 4. 深模块与 seam

### 4.1 CanonicalSessionEngine

新包：packages/canonical-session-engine

外部 interface 只提供：

    observeCodex(input): Promise<ObservationReceipt>
    commitDshAppend(input): Promise<CanonicalCommitReceipt>
    tombstone(input): Promise<TombstoneReceipt>
    restore(input): Promise<RestoreSessionReceipt>

它隐藏：

- 相同内容空操作；
- 版本和内容对象写入；
- Codex 延迟派生；
- operationId 幂等；
- 工作区、标题和标签继承；
- 墓碑和恢复；
- 版本头事务。

### 4.2 ProjectionLifecycle

新包：packages/projection-lifecycle

外部 interface 只提供：

    openRun(input): Promise<ProjectionRunHandle>
    append(handle, input): Promise<ProjectionCommitReceipt>
    closeRun(handle): Promise<ProjectionCloseReceipt>
    recover(runId): Promise<ProjectionRecoveryReceipt>

它隐藏：

- 租约；
- Adapter 选择；
-完整物化；
- WAL；
-投影 revision；
- 正常关闭；
- 异常恢复；
- P1-P5、P8 状态日志。

### 4.3 StatusLog

新包：packages/session-status-log

外部 interface：

    start(input): Promise<StatusSpan>
    succeed(span, detail?): Promise<void>
    fail(span, error): Promise<void>
    list(query): Promise<Page<StatusEvent>>
    subscribe(query): AsyncIterable<StatusEvent>

SQLite 和内存 Adapter 形成真实 seam。测试与调用方都只跨该 interface。

### 4.4 Adapter SDK

新包：

- packages/session-adapter-sdk；
- packages/adapter-host；
- packages/adapter-dsh-alpha2；
- packages/adapter-dsh-rc2。

适配器只处理 DSH 版本知识，不访问 Maintenance 数据库，不决定会话派生和删除。

### 4.5 替换而非叠层

packages/native-mirror-engine 在迁移期间只作为旧数据读取来源。T19 完成后：

- Engine 不再 import 它；
- Dashboard 不再展示 native mirror 操作；
- tests/integration/codex-native-mirror.test.ts 被延迟派生测试替代；
- 包从工作区删除；
- 旧数据库表只保留在封存数据库和迁移读取器中。

## 5. Batch A：规范模型、存储与迁移预览

### T01：定义规范会话、投影和状态日志 contracts

文件：

- 新建 packages/contracts/src/canonical.ts
- 新建 packages/contracts/src/projection.ts
- 新建 packages/contracts/src/status.ts
- 新建 packages/contracts/src/adapter-sdk.ts
- 修改 packages/contracts/src/model.ts
- 修改 packages/contracts/src/adapters.ts
- 修改 packages/contracts/src/store.ts
- 修改 packages/contracts/src/http.ts
- 修改 packages/contracts/src/schemas.ts
- 修改 packages/contracts/src/index.ts
- 新建 packages/contracts/test/canonical-projection-contracts.test.ts
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T01.md

步骤：

1. 写 contracts 测试，覆盖 authorityScope、originKind、session derivation、logical workspace、projection run、operation receipt、status event、adapter manifest 和 tombstone 的解析。
2. 添加 CanonicalEventV1 与 opaque unknown event。
3. 添加 runId、leaseId、baseVersionId、branchId 和 operationId branded IDs。
4. 添加 P1-P8 固定 stage union。
5. 添加 CanonicalSessionRepository、ProjectionRunRepository 和 StatusEventRepository 的最小 interface。
6. 旧 NativeMirror 类型暂时保留并标记 legacy；禁止新模块依赖。
7. 导出新 contracts。

聚焦验证：

    pnpm exec vitest run packages/contracts/test/canonical-projection-contracts.test.ts packages/contracts/test/contracts.test.ts

完成标准：

- 新 interface 可编译；
- 非法 authority、stage 和 adapterApiVersion 被拒绝；
- 旧包尚能编译。

提交：

    feat(contracts): define canonical projection interfaces

### T02：建立规范会话、派生、工作区和别名存储

文件：

- 新建 packages/session-store/src/migrations/007-canonical-session-source.ts
- 新建 packages/session-store/src/canonical-repository.ts
- 新建 packages/session-store/src/logical-workspace-repository.ts
- 新建 packages/session-store/src/session-alias-repository.ts
- 修改 packages/session-store/src/database.ts
- 修改 packages/session-store/src/schema.ts
- 修改 packages/session-store/src/index.ts
- 修改 packages/session-store/src/repository.ts
- 新建 packages/session-store/test/migration-007.test.ts
- 新建 packages/session-store/test/canonical-repository.test.ts
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T02.md

步骤：

1. 先用 v6 合成数据库写失败迁移测试。
2. 新增 session_derivations、canonical_events、logical_workspaces、workspace_memberships、session_aliases 和 session_tombstones。
3. 为 logical_sessions 增加 authority 和 origin 属性，不改写旧正文。
4. 用独立 repository 文件承载新行为，避免继续扩大现有 1991 行 repository.ts。
5. 实现 operationId 唯一约束、派生来源约束和逻辑工作区单一归属约束。
6. 证明旧 v6 表与数据仍在。

聚焦验证：

    pnpm exec vitest run packages/session-store/test/migration-007.test.ts packages/session-store/test/canonical-repository.test.ts

完成标准：

- v6 合成数据库升级到 v7；
- 旧 native_mirrors 未被删除；
- 规范会话和派生关系可原子写入并读取。

提交：

    feat(store): add canonical session and workspace schema

### T03：建立运行、投影、WAL、Adapter 和状态日志存储

文件：

- 新建 packages/session-store/src/migrations/008-projection-runtime.ts
- 新建 packages/session-store/src/projection-run-repository.ts
- 新建 packages/session-store/src/status-event-repository.ts
- 新建 packages/session-store/src/adapter-registry-repository.ts
- 修改 packages/session-store/src/database.ts
- 修改 packages/session-store/src/schema.ts
- 修改 packages/session-store/src/index.ts
- 新建 packages/session-store/test/migration-008.test.ts
- 新建 packages/session-store/test/projection-run-repository.test.ts
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T03.md

步骤：

1. 写租约唯一性、operationId 幂等和状态事件顺序测试。
2. 新增 projection_runs、projection_sessions、projection_workspaces、run_operations、run_status_events、adapter_registrations 和 adapter_verification_runs。
3. 实现同一主分支只能有一个活动 DSH writer lease。
4. 实现 run operation receipt 查询。
5. 实现按 runId、logicalSessionId、operationId 和 stage 查询状态事件。

聚焦验证：

    pnpm exec vitest run packages/session-store/test/migration-008.test.ts packages/session-store/test/projection-run-repository.test.ts

完成标准：

- 第二个活动租约被一致拒绝；
- 重复 operationId 返回同一记录；
- 状态日志可按时间和 span 查询。

提交：

    feat(store): add projection runtime persistence

### T04：实现 CanonicalSessionEngine

文件：

- 新建 packages/canonical-session-engine/package.json
- 新建 packages/canonical-session-engine/tsconfig.json
- 新建 packages/canonical-session-engine/src/index.ts
- 新建 packages/canonical-session-engine/src/engine.ts
- 新建 packages/canonical-session-engine/src/codex-observation.ts
- 新建 packages/canonical-session-engine/src/dsh-append.ts
- 新建 packages/canonical-session-engine/src/tombstone.ts
- 新建 packages/canonical-session-engine/test/engine.test.ts
- 修改 pnpm-lock.yaml
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T04.md

步骤：

1. 用 interface 测试写四个主结果：Codex 空操作、Codex 增量、DSH 原生追加、墓碑恢复。
2. 复用 session-domain 的规范化与摘要逻辑，不复制平台读取代码。
3. 将版本头、内容对象、工作区和 receipt 写入收拢到一个事务。
4. 延迟派生只定义事务入口，本任务不接 DSH 投影。
5. 返回明确的 created、advanced、noop、derived 和 tombstoned receipt。

聚焦验证：

    pnpm exec vitest run packages/canonical-session-engine/test/engine.test.ts

完成标准：

- 相同 Codex 内容不产生版本；
- DSH native session 可追加；
- 删除和恢复产生新状态而不改旧版本。

提交：

    feat(engine): add canonical session engine

### T05：实现 v6 迁移预览，不执行切换

文件：

- 新建 packages/session-store/src/canonical-migration.ts
- 修改 packages/session-store/src/index.ts
- 修改 apps/engine/src/http/routes.ts
- 修改 apps/engine/src/http/dashboard.ts
- 修改 packages/contracts/src/http.ts
- 新建 packages/session-store/test/canonical-migration-preview.test.ts
- 新建 apps/engine/test/canonical-migration-preview.test.ts
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T05.md

步骤：

1. 创建包含 Codex-only、DSH-only、equal、source-ahead、target-ahead 和 diverged 的合成 v6 fixture。
2. 实现 preview，只读取旧 native_mirrors 和 binding_workspaces。
3. 输出 codex_mirror、maintenance_native、codex_derived、待复核和待归类计数。
4. 输出源库摘要、候选库目标路径和回滚信息。
5. Engine 提供只读迁移预览 route。
6. 断言源数据库每个文件摘要不变。

聚焦验证：

    pnpm exec vitest run packages/session-store/test/canonical-migration-preview.test.ts apps/engine/test/canonical-migration-preview.test.ts

Gate A：

- 迁移预览结果可解释；
- 无法确定的分裂不自动合并；
- 源库零写入。

提交：

    feat(migration): preview canonical session conversion

## 6. Batch B：状态日志、Adapter SDK 和 Alpha2 Codec

### T06：实现 StatusLog 深模块和诊断事件流

文件：

- 新建 packages/session-status-log/package.json
- 新建 packages/session-status-log/tsconfig.json
- 新建 packages/session-status-log/src/index.ts
- 新建 packages/session-status-log/src/status-log.ts
- 新建 packages/session-status-log/src/memory-adapter.ts
- 新建 packages/session-status-log/src/sqlite-adapter.ts
- 新建 packages/session-status-log/test/status-log.test.ts
- 修改 apps/engine/src/http/routes.ts
- 修改 apps/engine/src/http/sse.ts
- 修改 apps/engine/src/composition-root.ts
- 新建 apps/engine/test/status-events.test.ts
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T06.md

步骤：

1. 写同一个 interface 对内存和 SQLite Adapter 的参数化测试。
2. 实现 start、succeed、fail、list 和 subscribe。
3. 限制默认 detail，正文与 token 不进入日志。
4. Engine 暴露状态事件查询与 SSE。
5. 定义 child stage 只能带 parentEventId 或 spanId。

聚焦验证：

    pnpm exec vitest run packages/session-status-log/test/status-log.test.ts apps/engine/test/status-events.test.ts

完成标准：

- started 和 terminal state 成对；
- SSE 收到同一持久事件；
- 日志脱敏测试通过。

提交：

    feat(status): add persistent diagnostic spans

### T07：发布 Adapter SDK interface、示例和 Core Smoke

文件：

- 新建 packages/session-adapter-sdk/package.json
- 新建 packages/session-adapter-sdk/tsconfig.json
- 新建 packages/session-adapter-sdk/src/index.ts
- 新建 packages/session-adapter-sdk/src/manifest.ts
- 新建 packages/session-adapter-sdk/src/adapter.ts
- 新建 packages/session-adapter-sdk/src/runtime-bridge.ts
- 新建 packages/session-adapter-sdk/src/conformance.ts
- 新建 packages/session-adapter-sdk/test/conformance.test.ts
- 新建 docs/adapters/README.md
- 新建 docs/adapters/architecture.md
- 新建 docs/adapters/contract.md
- 新建 docs/adapters/capabilities.md
- 新建 docs/adapters/version-negotiation.md
- 新建 docs/adapters/authoring-guide.md
- 新建 docs/adapters/testing-guide.md
- 新建 docs/adapters/publishing-guide.md
- 新建 docs/adapters/compatibility-matrix.md
- 新建 docs/adapters/examples/minimal-adapter/package.json
- 新建 docs/adapters/examples/minimal-adapter/src/index.ts
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T07.md

步骤：

1. 先写 minimal fake Adapter 的 Core Smoke。
2. 定义 Manifest、能力、probe、materialize、normalizeAppend、inspect、verify 和 resolveReference。
3. 定义 Runtime Bridge attach、drain 和 detach。
4. 实现 Core Smoke，只测 probe、一个会话、一次追加、一次关闭和摘要。
5. 文档明确 semver 不硬锁实验模式。
6. 文档明确 Adapter 不访问 Maintenance 数据库。

聚焦验证：

    pnpm exec vitest run packages/session-adapter-sdk/test/conformance.test.ts

完成标准：

- 第三方示例只依赖 SDK；
- experimental Adapter 可运行；
- 不可理解的 adapterApiVersion 给出明确报告。

提交：

    feat(adapter-sdk): publish dsh session adapter contract

### T08：实现 Adapter Host 与 Registry

文件：

- 新建 packages/adapter-host/package.json
- 新建 packages/adapter-host/tsconfig.json
- 新建 packages/adapter-host/src/index.ts
- 新建 packages/adapter-host/src/host.ts
- 新建 packages/adapter-host/src/rpc.ts
- 新建 packages/adapter-host/src/registry.ts
- 新建 packages/adapter-host/test/host.test.ts
- 修改 apps/engine/src/composition-root.ts
- 修改 apps/engine/src/http/routes.ts
- 新建 apps/engine/test/adapter-registry.test.ts
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T08.md

步骤：

1. 用三个 fake Adapter 测试 verified、experimental 和 process crash。
2. 子进程只接收 typed DTO、投影根和受控端口。
3. 实现超时、进程退出、日志采集和重启。
4. Registry 支持 npm 包、本地目录和 Generation 登记。
5. 选择顺序实现 pinned、verified、probe-compatible、experimental。
6. 普通 DSH 版本范围不阻止选择。

聚焦验证：

    pnpm exec vitest run packages/adapter-host/test/host.test.ts apps/engine/test/adapter-registry.test.ts

完成标准：

- Adapter crash 不带崩 Engine；
- 选择理由持久化；
- experimental 选择记录在 verification run。

提交：

    feat(adapter-host): isolate and select dsh adapters

### T09：实现 Alpha2 Engine Codec

文件：

- 新建 packages/adapter-dsh-alpha2/package.json
- 新建 packages/adapter-dsh-alpha2/tsconfig.json
- 新建 packages/adapter-dsh-alpha2/src/index.ts
- 新建 packages/adapter-dsh-alpha2/src/manifest.ts
- 新建 packages/adapter-dsh-alpha2/src/probe.ts
- 新建 packages/adapter-dsh-alpha2/src/materialize.ts
- 新建 packages/adapter-dsh-alpha2/src/normalize-append.ts
- 新建 packages/adapter-dsh-alpha2/src/inspect.ts
- 新建 packages/adapter-dsh-alpha2/src/references.ts
- 新建 packages/adapter-dsh-alpha2/test/core-smoke.test.ts
- 新建 packages/adapter-dsh-alpha2/CHANGELOG.md
- 新建 packages/adapter-dsh-alpha2/BREAKING-CHANGES.md
- 新建 packages/adapter-dsh-alpha2/COMPATIBILITY.md
- 修改 docs/adapters/compatibility-matrix.md
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T09.md

步骤：

1. 从已安装 Alpha2 包提取脱敏合成 fixture，不复制用户会话。
2. 实现 package 和能力 probe。
3. 实现规范会话到 Alpha2 临时投影的 Codec。
4. 实现 inspect 和 digest verify。
5. 实现原生追加到 CanonicalEventV1。
6. 未知事件保存 raw payload 并报告 held-out。
7. 运行 SDK Core Smoke。

聚焦验证：

    pnpm exec vitest run packages/adapter-dsh-alpha2/test/core-smoke.test.ts

Gate B：

- Alpha2 Codec 通过 Core Smoke；
- Adapter 选择和测试结果可从 Engine 查询；
- 状态事件持久化和 SSE 可用。

提交：

    feat(adapter-alpha2): implement canonical projection codec

## 7. Batch C：Alpha2 投影主链

### T10：实现 openRun、完整物化和 Alpha2 Runtime Bridge

文件：

- 新建 packages/projection-lifecycle/package.json
- 新建 packages/projection-lifecycle/tsconfig.json
- 新建 packages/projection-lifecycle/src/index.ts
- 新建 packages/projection-lifecycle/src/lifecycle.ts
- 新建 packages/projection-lifecycle/src/lease.ts
- 新建 packages/projection-lifecycle/src/materialize.ts
- 新建 packages/projection-lifecycle/test/open-run.test.ts
- 新建 packages/adapter-dsh-alpha2/src/runtime-bridge.ts
- 新建 packages/adapter-dsh-alpha2/test/runtime-bridge.test.ts
- 修改 apps/engine/src/composition-root.ts
- 修改 plugins/dsh-session-maintenance/src/index.ts
- 修改 plugins/dsh-session-maintenance/src/config.ts
- 新建 plugins/dsh-session-maintenance/src/projection-runtime.ts
- 新建 plugins/dsh-session-maintenance/test/projection-runtime.test.ts
- 新建 tests/integration/alpha2-projection-open.test.ts
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T10.md

步骤：

1. 写 openRun 合成测试，预期 P1、P2、P3 顺序成功。
2. 获取唯一 writer lease。
3. 从 Maintenance 完整读取工作区与会话。
4. 调用 Alpha2 Codec 生成 run 专属投影。
5. 写 ProjectionManifest 并核对计数和摘要。
6. Runtime Bridge 接入 Alpha2 sessionPersistence。
7. 插件启动只接收 runId 和 Maintenance endpoint，不接收任意会话路径。
8. 第二个 writer run 返回 LEASE_HELD。

聚焦验证：

    pnpm exec vitest run packages/projection-lifecycle/test/open-run.test.ts packages/adapter-dsh-alpha2/test/runtime-bridge.test.ts plugins/dsh-session-maintenance/test/projection-runtime.test.ts tests/integration/alpha2-projection-open.test.ts

断点审查：

- P1 failed：只检查租约区间。
- P2 failed：只细分读取、转换、manifest、digest。
- P3 failed：只细分 Bridge attach 和 sessionPersistence register。

完成标准：

- Alpha2 可以列出合成 Maintenance 会话；
- P1-P3 日志完整；
- Profile 永久 sessions 目录没有被写入。

提交：

    feat(projection): open alpha2 maintenance runs

### T11：实现 WAL 和增量规范提交

文件：

- 新建 packages/projection-lifecycle/src/wal.ts
- 新建 packages/projection-lifecycle/src/append.ts
- 修改 packages/projection-lifecycle/src/lifecycle.ts
- 新建 packages/projection-lifecycle/test/append.test.ts
- 修改 packages/adapter-dsh-alpha2/src/runtime-bridge.ts
- 修改 packages/canonical-session-engine/src/dsh-append.ts
- 新建 tests/integration/alpha2-projection-append.test.ts
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T11.md

步骤：

1. 写一次 user/assistant 追加的 P4 失败测试。
2. 原生 revision 校验后先持久写 WAL。
3. 更新临时投影。
4. 调用 Codec normalizeAppend。
5. 通过 CanonicalSessionEngine 提交 operationId。
6. 写 receipt 并推进 projection revision。
7. 重复 operationId 返回同一 receipt。
8. Maintenance 暂时不可用时保留 pending 状态，不删除 WAL。

聚焦验证：

    pnpm exec vitest run packages/projection-lifecycle/test/append.test.ts tests/integration/alpha2-projection-append.test.ts

断点审查：

- P4 默认只记录 started、succeeded 或 failed。
- 失败后才在 WAL durable 与 receipt written 之间增加 child stage。

完成标准：

- 一次 Alpha2 回答进入 Maintenance 新版本；
- 重放不重复；
- P4 可按 operationId 查询。

提交：

    feat(projection): commit alpha2 appends through wal

### T12：实现 Codex 延迟派生

文件：

- 修改 packages/canonical-session-engine/src/codex-observation.ts
- 修改 packages/canonical-session-engine/src/dsh-append.ts
- 新建 packages/canonical-session-engine/src/derivation.ts
- 新建 packages/canonical-session-engine/test/derivation.test.ts
- 修改 packages/projection-lifecycle/src/append.ts
- 新建 tests/integration/codex-delayed-derivation.test.ts
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T12.md

步骤：

1. 写“投影后关闭不分裂”测试。
2. 写“第一次追加只创建一个 child”测试。
3. 固定 projection baseVersionId。
4. 在一个事务中创建 child、derivation、继承元数据、追加事件并切换 mapping。
5. 不复制 Codex authority binding。
6. 模拟事务中断并用同一 operationId 恢复。
7. 模拟 Codex 在运行期间继续增量，证明原会话和 child 独立前进。

聚焦验证：

    pnpm exec vitest run packages/canonical-session-engine/test/derivation.test.ts tests/integration/codex-delayed-derivation.test.ts

断点审查：

- P5 failed 时只细分 child create、derivation insert、inherit metadata、mapping switch。

完成标准：

- 只读零派生；
- 首次追加一个派生；
- 派生继承工作区、标题和标签；
- Codex binding 只留在原会话。

提交：

    feat(engine): derive dsh sessions on first codex append

### T13：实现 drain、close 和异常恢复

文件：

- 新建 packages/projection-lifecycle/src/close.ts
- 新建 packages/projection-lifecycle/src/recovery.ts
- 修改 packages/projection-lifecycle/src/lifecycle.ts
- 新建 packages/projection-lifecycle/test/close-recovery.test.ts
- 修改 packages/adapter-dsh-alpha2/src/runtime-bridge.ts
- 修改 plugins/dsh-session-maintenance/src/projection-runtime.ts
- 新建 tests/integration/projection-recovery.test.ts
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T13.md

步骤：

1. 写正常关闭和 WAL 中断两个场景。
2. drain 停止新写入并提交全部 pending operation。
3. 核对版本头、工作区清单和摘要。
4. 建立关闭 Checkpoint。
5. detach Bridge、删除投影、释放租约。
6. 异常时保留 manifest、WAL、投影和状态日志。
7. 恢复按 operationId 重放，无法解析进入 quarantine。
8. cleanup 失败进入 CLEANUP_PENDING，不伪报 CLOSED。

聚焦验证：

    pnpm exec vitest run packages/projection-lifecycle/test/close-recovery.test.ts tests/integration/projection-recovery.test.ts

Gate C：

- Alpha2 P1-P5、P8 成功；
- 正常关闭后临时投影消失；
- 异常写入可恢复且不重复；
- 本批不运行全仓测试。

提交：

    feat(projection): close and recover maintenance runs

## 8. Batch D：引用、WebUI、删除和恢复

### T14：迁移深链接到 logicalSessionId，并保留历史别名

主仓文件：

- 修改 packages/contracts/src/canonical.ts
- 修改 packages/session-store/src/session-alias-repository.ts
- 修改 apps/engine/src/http/routes.ts
- 修改 plugins/dsh-session-maintenance/src/client/session-locator.ts
- 新建 tests/integration/reference-roundtrip.test.ts
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T14.md

Annotation Core 仓库：

- D:\AI\DSH-Plugin-Repositories\dsh-annotation-core\src\protocol\schema.ts
- D:\AI\DSH-Plugin-Repositories\dsh-annotation-core\src\protocol\serialization.ts
- D:\AI\DSH-Plugin-Repositories\dsh-annotation-core\src\client\answer-link.ts
- D:\AI\DSH-Plugin-Repositories\dsh-annotation-core\src\host\session-reconcile.ts
- D:\AI\DSH-Plugin-Repositories\dsh-annotation-core\tests\answer-link.test.tsx

Sticker Board 仓库：

- D:\AI\DSH-Plugin-Repositories\dsh-session-sticker-board\src\protocol.ts
- D:\AI\DSH-Plugin-Repositories\dsh-session-sticker-board\src\client\deep-link.ts
- D:\AI\DSH-Plugin-Repositories\dsh-session-sticker-board\src\host\obsidian-source-adapter.ts
- D:\AI\DSH-Plugin-Repositories\dsh-session-sticker-board\tests\deep-link.test.ts

Obsidian Bridge 仓库：

- D:\AI\DSH-Plugin-Repositories\obsidian-deepharness-bridge\src\protocol.ts
- D:\AI\DSH-Plugin-Repositories\obsidian-deepharness-bridge\src\logical-link.ts
- D:\AI\DSH-Plugin-Repositories\obsidian-deepharness-bridge\src\webviewer\deep-link.ts
- D:\AI\DSH-Plugin-Repositories\obsidian-deepharness-bridge\src\vault\references.ts
- D:\AI\DSH-Plugin-Repositories\obsidian-deepharness-bridge\src\vault\sticker-backlink-lifecycle.ts
- D:\AI\DSH-Plugin-Repositories\obsidian-deepharness-bridge\tests\protocol-v2.test.ts
- D:\AI\DSH-Plugin-Repositories\obsidian-deepharness-bridge\tests\sticker-backlink-lifecycle.test.ts

步骤：

1. 执行前分别读取各仓库 AGENTS.md 并确认工作树。
2. 新引用写 logicalSessionId、logicalAnchorId 和可选 legacy sessionId。
3. Maintenance 用活动 projection mapping 解析当前 native session ID。
4. 旧链接通过 session_aliases 解析。
5. 删除引用时结束 Annotation、Sticker 和 Obsidian 双链，不影响会话正文。
6. 不改现有气泡展示和已确认删除语义。
7. 每个仓库只加一条 focused regression。
8. P7 记录 reference type、logicalSessionId 和 resolution result，不记录引用正文。

聚焦验证：

    pnpm exec vitest run tests/integration/reference-roundtrip.test.ts

各外部仓库只运行上面列出的对应测试文件和 build。

提交：

- 主仓：feat(references): resolve links through logical sessions
- Annotation Core：feat: support maintenance logical session links
- Sticker Board：feat: resolve stickers through logical sessions
- Obsidian Bridge：feat: persist maintenance logical session links

完成标准：

- 新旧引用都能解析当前投影；
- 切换会话不被旧跳转拉回；
- 删除双链后旧气泡不可继续触发；
- P7 成功。

### T15：重构独立 WebUI 的工作区树、静态会话和谱系

文件：

- 修改 apps/dashboard/src/app.tsx
- 修改 apps/dashboard/src/workspace-directory.tsx
- 修改 apps/dashboard/src/session-workbench.tsx
- 修改 apps/dashboard/src/catalog-pages.tsx
- 新建 apps/dashboard/src/lineage-view.tsx
- 新建 apps/dashboard/src/canonical-event-view.tsx
- 修改 apps/dashboard/src/dashboard.css
- 修改 apps/engine/src/http/dashboard.ts
- 修改 apps/engine/src/http/routes.ts
- 修改 packages/contracts/src/http.ts
- 新建 apps/dashboard/test/canonical-workspace-model.test.ts
- 新建 apps/engine/test/canonical-dashboard-api.test.ts
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T15.md

步骤：

1. 写一条模型测试，覆盖工作区树、三种来源和派生谱系。
2. 左栏改读 logical_workspaces 和 workspace_memberships。
3. 右栏渲染 CanonicalEventV1，不读取 DSH 文件。
4. 未知事件显示 held-out 占位和诊断链接。
5. 来源图支持原会话和派生会话双向跳转。
6. 页面加入稳定 route、可访问名称和 data-testid。

聚焦验证：

    pnpm exec vitest run apps/dashboard/test/canonical-workspace-model.test.ts apps/engine/test/canonical-dashboard-api.test.ts

完成标准：

- DSH 未运行时仍可查看完整会话；
- 同标题来源可区分；
- WebUI 不执行历史工具和 HTML。

提交：

    feat(dashboard): browse canonical workspaces and lineage

### T16：实现删除、恢复、Checkpoint、运行中心和 Adapter 页面

文件：

- 修改 apps/dashboard/src/operations-pages.tsx
- 新建 apps/dashboard/src/run-center.tsx
- 新建 apps/dashboard/src/adapter-page.tsx
- 新建 apps/dashboard/src/recently-deleted.tsx
- 修改 apps/dashboard/src/app.tsx
- 修改 apps/engine/src/http/routes.ts
- 修改 apps/engine/src/http/dashboard.ts
- 修改 packages/canonical-session-engine/src/tombstone.ts
- 修改 packages/projection-lifecycle/src/lifecycle.ts
- 新建 apps/dashboard/test/maintenance-operations.test.ts
- 新建 apps/engine/test/maintenance-operations-api.test.ts
- 新建 tests/integration/delete-restore-projection.test.ts
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T16.md

步骤：

1. 写删除前 Checkpoint、墓碑、活动投影隐藏和恢复的单一主链测试。
2. 实现工作区移动、标题、标签、固定和归档。
3. 删除工作区时会话转到未归类。
4. 删除 Codex 镜像不写 Codex。
5. 删除活动会话先排空 pending write；失败进入 pending-delete。
6. 实现最近删除和恢复。
7. 运行中心显示 P1-P8、租约、pending、Adapter 和恢复状态。
8. Adapter 页面允许 experimental 选择，不因 semver 禁用。

聚焦验证：

    pnpm exec vitest run apps/dashboard/test/maintenance-operations.test.ts apps/engine/test/maintenance-operations-api.test.ts tests/integration/delete-restore-projection.test.ts

Gate D：

- WebUI 能查看、移动、删除、恢复；
- P7 和双链测试通过；
- 活动会话删除不丢 pending write；
- 不运行全仓 UI 测试。

提交：

    feat(dashboard): manage canonical sessions and runs

## 9. Batch E：RC2、Launcher 与正式迁移

### T17：实现 RC2 Adapter 和跨版本验证

文件：

- 新建 packages/adapter-dsh-rc2/package.json
- 新建 packages/adapter-dsh-rc2/tsconfig.json
- 新建 packages/adapter-dsh-rc2/src/index.ts
- 新建 packages/adapter-dsh-rc2/src/manifest.ts
- 新建 packages/adapter-dsh-rc2/src/probe.ts
- 新建 packages/adapter-dsh-rc2/src/materialize.ts
- 新建 packages/adapter-dsh-rc2/src/normalize-append.ts
- 新建 packages/adapter-dsh-rc2/src/runtime-bridge.ts
- 新建 packages/adapter-dsh-rc2/src/inspect.ts
- 新建 packages/adapter-dsh-rc2/src/references.ts
- 新建 packages/adapter-dsh-rc2/test/core-smoke.test.ts
- 新建 packages/adapter-dsh-rc2/CHANGELOG.md
- 新建 packages/adapter-dsh-rc2/BREAKING-CHANGES.md
- 新建 packages/adapter-dsh-rc2/COMPATIBILITY.md
- 修改 docs/adapters/compatibility-matrix.md
- 新建 tests/integration/cross-version-projection.test.ts
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T17.md

步骤：

1. 复用 SDK，不复制 ProjectionLifecycle。
2. 使用 RC2 合成 fixture 实现 Codec 和 Runtime Bridge。
3. 把 RC2 内部 hook 封装在包内。
4. 顺序运行 Alpha2 关闭、RC2 打开。
5. 比较 logical workspace、session、version 和 reference digest。
6. P6 只记录两个 runId、adapterId、catalog digest 和结果。

聚焦验证：

    pnpm exec vitest run packages/adapter-dsh-rc2/test/core-smoke.test.ts tests/integration/cross-version-projection.test.ts

完成标准：

- Alpha2 和 RC2 顺序看到同一逻辑结构；
- Profile Home 无永久会话；
- P6 成功。

提交：

    feat(adapter-rc2): project canonical sessions into rc2

### T18：接入 DSH Launcher Profile

Launcher 仓库：D:\AI\DSH-Launcher\source

文件：

- 修改 src/api/types.ts
- 修改 src/stores/launcher.ts
- 修改 src/views/InstanceEdit.vue
- 修改 src/locales/zh-CN.json
- 修改 src/locales/en-US.json
- 修改 src-tauri/src/config.rs
- 修改 src-tauri/src/runtime.rs
- 修改 src-tauri/src/process.rs
- 修改 src-tauri/src/commands.rs
- 新增相邻 Rust focused tests
- 新建 Launcher 仓库变更记录

Session Maintenance 主仓：

- 修改 plugins/dsh-session-maintenance/src/config.ts
- 修改 plugins/dsh-session-maintenance/src/index.ts
- 修改 apps/engine/src/config.ts
- 修改 apps/engine/src/main.ts
- 新建 plugins/dsh-session-maintenance/test/launcher-profile.test.ts
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T18.md

步骤：

1. 执行前读取 Launcher AGENTS.md 并检查工作树。
2. Profile 增加 sessionSource、maintenanceEndpoint、adapterSelection 和 pinnedAdapterId。
3. 启动时发现或唤醒 Engine，并把 run metadata 交给插件。
4. 不把真实会话目录写入 Profile 配置。
5. 关闭时等待插件 drain；强退依靠心跳恢复。
6. Launcher 显示活动租约、pending 和打开 WebUI 入口。
7. 保留未来 branchId 配置位置但不开放多写 UI。

聚焦验证：

Session Maintenance：

    pnpm exec vitest run plugins/dsh-session-maintenance/test/launcher-profile.test.ts

Launcher：

    cargo test --manifest-path src-tauri/Cargo.toml maintenance_profile
    pnpm build

提交：

- 主仓：feat(plugin): bind launcher profiles to maintenance runs
- Launcher：feat: add maintenance-backed session profiles

完成标准：

- Alpha2 和 RC2 Profile 指向同一 Maintenance endpoint；
- 关闭一个再开另一个不改变工作区；
- Launcher 不复制或永久保存会话。

### T19：执行候选迁移、切换真源并删除 native mirror 主线

文件：

- 修改 packages/session-store/src/canonical-migration.ts
- 修改 apps/engine/src/config.ts
- 修改 apps/engine/src/http/routes.ts
- 修改 apps/engine/src/composition-root.ts
- 修改 apps/engine/src/engine.ts
- 修改 apps/dashboard/src/operations-pages.tsx
- 删除 packages/native-mirror-engine
- 删除 tests/integration/codex-native-mirror.test.ts
- 新建 tests/integration/canonical-migration-activation.test.ts
- 新建 tests/contract/no-native-mirror-runtime.test.ts
- 修改 docs/superpowers/plans/2026-08-27-session-maintenance-phase-4-native-mirror.md，标记为被取代
- 新建 docs/validation/canonical-migration-preview.md
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T19.md

步骤：

1. 先对用户真实 Maintenance 数据执行只读 preview。
2. 向用户展示计数、待复核项和回滚位置。
3. 未经用户确认不执行活动数据库切换。
4. 确认后复制旧库，在候选库执行迁移。
5. 校验候选库，再原子切换数据库指针。
6. 封存旧库只读。
7. Engine composition 改用 CanonicalSessionEngine 和 ProjectionLifecycle。
8. 删除 native-mirror-engine 运行依赖和旧操作 UI。
9. 合同测试禁止生产源码 import native-mirror-engine。

聚焦验证：

    pnpm exec vitest run tests/integration/canonical-migration-activation.test.ts tests/contract/no-native-mirror-runtime.test.ts

Gate E：

- 真实 preview 经用户确认；
- 候选库摘要和计数匹配；
- Alpha2、RC2 Profile 依次打开成功；
- 旧库可一键切回；
- native mirror 主线不再运行。

提交：

    refactor: replace native mirrors with canonical projection

## 10. Batch F：最小端到端验收与 Generation

### T20：执行一次完整检查、人工主链和稳定 Generation

文件：

- 新建 scripts/package-canonical-projection.mjs
- 新建 scripts/verify-canonical-projection-package.mjs
- 修改 package.json
- 修改 plugins/dsh-session-maintenance/package.json
- 修改 plugins/dsh-session-maintenance/README.md
- 新建 docs/validation/canonical-projection-final.md
- 新建 docs/deployment/canonical-projection-generation.md
- 新建 docs/changes/SESSION-MAINT-CANONICAL-T20.md
- 按各插件仓库要求更新 CHANGELOG

步骤：

1. 运行主仓完整 typecheck、build 和 test，仅此一次。
2. 运行 Adapter Core Smoke 和包验证。
3. 对 Annotation Core、Sticker Board、Obsidian Bridge 运行 T14 聚焦回归和 build。
4. 对 Launcher 运行 cargo test 与 pnpm build。
5. 构建包含 Engine、WebUI、SDK、Alpha2 Adapter、RC2 Adapter 和当前插件组合的 Generation。
6. 把同一 Generation 配置到 Alpha2 与 RC2 Launcher Profile。
7. 用浏览器控制观察 WebUI 和 DSH 页面，不替代用户点击验收。
8. 执行唯一人工主链：

   - 打开 WebUI；
   - 启动 Alpha2；
   - 查看工作区；
   - 打开 Codex 会话不发送，确认不派生；
   - 发送一次，确认只创建一个派生；
   - 检查 Annotation、Sticker 和 Obsidian 引用；
   - 正常关闭；
   - 启动 RC2；
   - 验证同一工作区和会话；
   - 在 Maintenance 删除并恢复测试会话。

9. 把 P1-P8 结果、Generation ID、插件提交和回滚点写入验证报告。
10. 用户验收通过后再推送各仓库和登记稳定 Generation。

最终命令只运行一次：

主仓：

    pnpm typecheck
    pnpm build
    pnpm test
    node scripts/package-canonical-projection.mjs
    node scripts/verify-canonical-projection-package.mjs

Launcher：

    cargo test --manifest-path src-tauri/Cargo.toml
    pnpm build

外部插件：

- 只运行 T14 指定的 focused tests；
- 每个仓库运行 build；
- 不额外执行无关全量 UI 测试。

Gate F：

- P1-P8 全部成功；
- Generation 可重复构建；
- Alpha2、RC2 顺序运行；
- Profile 关闭后不持有会话；
- Maintenance 删除和恢复正常；
- 旧库和旧 Generation 可回滚；
- 用户完成最终人工验收。

提交：

    feat: package canonical session projection generation

## 11. 依赖顺序

    T01 -> T02 -> T03 -> T04 -> T05
                    |
                    +-> T06 -> T07 -> T08 -> T09
                                      |
                                      +-> T10 -> T11 -> T12 -> T13
                                                        |
                                                        +-> T14 -> T15 -> T16
                                                                          |
                                                                          +-> T17 -> T18 -> T19 -> T20

不能提前执行：

- T10 不能早于 T06、T08、T09。
- T11 不能早于 T04。
- T12 不能早于 T11。
- T14 不能早于活动 projection mapping。
- T17 不能早于 Alpha2 主链稳定。
- T19 不能早于用户确认真实迁移 preview。
- T20 不能早于用户确认 T19 切换结果。

## 12. 每任务审查清单

每个任务提交前只检查：

- 是否只跨预定 module interface；
- 是否新增了未获批准的兼容层；
- 是否直接访问真实 Codex 或 DSH Home；
- 是否把 semver 警告变成实验硬锁；
- 是否给当前关键断点写了 started 和 terminal 状态；
- 是否只运行 focused tests；
- 是否记录变更报告；
- 工作树是否只包含本任务文件。

出现问题时不扩大测试范围，先查看最近两个状态断点之间的日志。

## 13. 停止条件

以下情况必须暂停任务并向用户报告，不得继续猜测：

- 真实迁移 preview 出现无法解释的会话丢失或数量差异；
- Adapter 无法无损保留已知 Annotation、Sticker 或 Obsidian 事件；
- Maintenance pending write 无法通过 operationId 判断是否已提交；
- 当前 DSH 版本没有可接管的 sessionPersistence seam；
- Launcher 无法在不持久保存会话路径的情况下传递 run metadata；
- 回滚数据库或 Checkpoint 校验失败；
- 用户实际验收与状态日志结果矛盾。

普通实验版本范围不匹配不是停止条件。先以 experimental 模式运行 Core Smoke，再根据实际失败断点决定是否新增 Adapter。

## 14. 计划完成定义

实施完成不是“测试数量很多”，而是以下业务结果全部由关键断点证明：

1. Maintenance 保存唯一 DSH 会话真源。
2. Codex 内容未被 Maintenance 修改。
3. 相同 Codex 导入是空操作。
4. 只读 Codex 投影不分裂。
5. 第一次 DSH 续写只创建一个派生会话。
6. Alpha2 与 RC2 顺序加载同一工作区。
7. Annotation、Sticker 和 Obsidian 双链跨版本可定位和删除。
8. 正常关闭清空投影。
9. 异常关闭可恢复 pending write。
10. 删除只能在 Maintenance 生效并可恢复。
11. 第三方可以按公开文档实现 Adapter。
12. Launcher Profiles 不再永久持有会话。
13. 稳定 Generation 和回滚点已登记。

本计划获用户审核前不创建实施分支、不修改运行代码、不迁移真实数据。
