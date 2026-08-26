# Session Maintenance Phase 2 DSH Write and UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在第一阶段只读内核之上交付官方 DSH `0.1.1-rc.2` 的安全事务写入、命名 Checkpoint、恢复链、独立 DSH 风格 Dashboard，以及只负责入口和平台 Adapter 的新 `dsh-session-maintenance` 插件。

**Baseline:** 正式基线为 `main` 的第一阶段提交 `8d4b23e`。规划分支为 `codex/phase-2-planning`；计划合并后，施工从更新后的 `main` 创建 `codex/phase-2-dsh-write-and-ui`。

**Architecture:** Engine 继续是唯一业务入口。新增 Transaction Module 负责计划复核、备份、journal、验证和恢复；DSH Write Adapter 是锁定官方 DSH 版本的 Implementation，只通过窄 Interface 执行平台动作。Dashboard、DSH 右键菜单和参数面板都只调用同一个受限本地 API，不复制计划、冲突或恢复逻辑。

**Tech Stack:** 延续阶段一栈；新增 React `19.1.1`、Vite、Testing Library、Playwright、Lucide、Markdown 渲染，以及锁定 `0.1.1-rc.2` 的 DSH host/client peer contracts。具体版本在 P18/P21 首次引入时一次性锁定。

**Spec:** `../specs/2026-08-26-dsh-codex-session-maintenance-design.md`

**Roadmap:** `2026-08-26-dsh-codex-session-maintenance-roadmap.md`

## 1. 固定业务边界

- 阶段二只开放 **Codex → DSH** 的可证明安全快进、单边标题同步、单边归档同步和新建 DSH 目标会话。
- DSH 与 Codex 已经分叉时只展示和保留两个分支；不得自动拼接、覆盖、重排或删除任一历史。
- DSH 写入支持版本仅为官方 `@deepseek-ai/dsh@0.1.1-rc.2` 及本计划锁定的 storage/schema fingerprint；版本或 fingerprint 漂移立即降为只读。
- 阶段二不写 Codex 原生存储、不创建 Codex 延续任务、不启用原生双向镜像；相关入口只显示“后续阶段提供”，不能提交伪作业。
- 不依赖、导入、启动或迁移旧 `dsh-codex-session-sync`、旧 ledger、`/codex-sync`、EAC、Maintenance Engine 或特定桌面壳。
- 旧同步插件只允许在 P22 正式 profile 验收通过、用户确认之后卸载；本计划的 P14–P21 不触碰正式 profile。
- 测试默认只使用带 marker 的临时 Codex/DSH home。所有平台写测试必须在进程级拒绝真实 home。
- 每个 P 任务必须先有失败测试，再实现最小能力，并附修改报告和独立 Git 提交。

## 2. Module、Interface、Implementation 与 Adapter

第二阶段增加下列深 Module；外部调用面保持窄，内部容纳复杂恢复逻辑：

| Module | 对外 Interface | Implementation / Adapter | 不允许泄漏的细节 |
| --- | --- | --- | --- |
| Transaction | `applyPlan`、`getTransaction`、`restoreTransaction`、`createCheckpoint` | journal 状态机、fsync、备份 manifest、单根写队列、恢复 | 文件顺序、临时目录、重试细节 |
| DSH Write | `PlatformWriteAdapter` | DSH `0.1.1-rc.2` host gateway + Engine transport | DSH event、projection、workspace、storage 格式 |
| Operation API | 类型化 query/command DTO | HTTP/SSE routes、job runner、confirmation nonce | token、state root、任意路径 |
| Session UI | `SessionMaintenanceClient` + view models | Dashboard pages、GitGraph、diff、recovery UI | SQLite、平台文件、事务写步骤 |
| DSH Entry | `SessionMaintenanceActions` | 右键菜单、参数/操作面板、Dashboard 打开入口 | 计划算法、备份、直接文件写入 |

读取与写入是两个独立 Seam。第一阶段 `SessionReadAdapter` 保持不变；第二阶段新增接口，不向只读 Adapter 塞入可选写方法：

```ts
interface PlatformWriteAdapter {
  readonly platform: "dsh";
  probeWrite(instance: RegisteredInstance): Promise<WriteProbe>;
  prepare(request: PrepareWriteRequest): Promise<PreparedWrite>;
  backup(prepared: PreparedWrite, transaction: TransactionContext): Promise<BackupManifest>;
  commit(prepared: PreparedWrite, transaction: TransactionContext): Promise<WriteReceipt>;
  verify(receipt: WriteReceipt, expected: ExpectedPlatformState): Promise<VerificationResult>;
  restore(backup: BackupManifest, transaction: TransactionContext): Promise<RestoreReceipt>;
}

interface WriteEngine extends ReadOnlyEngine {
  applyPlan(request: ApplyPlanRequest): Promise<TransactionRef>;
  getTransaction(id: string): Promise<TransactionRecord | undefined>;
  restoreTransaction(request: RestoreTransactionRequest): Promise<TransactionRef>;
  createCheckpoint(request: CreateCheckpointRequest): Promise<Checkpoint>;
  createCheckpointRestorePlan(request: CheckpointRestoreRequest): Promise<SyncPlan>;
}
```

`PlatformWriteAdapter` 是未来 Codex 原生 Adapter 的真实替换 Seam。Dashboard 或 DSH client 不得获得该 Interface 的对象引用。

## 3. DSH 写入拓扑

```text
Dashboard / DSH client
          │ plan ID + action
          ▼
loopback API ──> Engine Transaction Module ──> DSH write transport
                          │                          │
                          │ journal/backups         ▼
                          │                    DSH host gateway
                          │                          │
                          └──────── verify <── official DSH services
```

DSH host gateway 随新插件打包，但属于平台 Adapter，不属于 UI。它必须：

- 注入并使用官方 `sessionPersistence`、`sessions`、`workspaceRegistry` 及必要的 projection/storage service；
- 在任何 mutation 前核对平台版本、schema fingerprint、目标 session ID、workspace 映射和 Engine 签发的短期事务令牌；
- 目标会话处于 live/append 状态时返回 `DSH_BUSY`；不结束 Agent、不猜测安全窗口；
- 只执行已持久化计划中的允许操作；不接受任意路径、任意事件或任意 shell 命令；
- 将可恢复平台数据交给 Engine 备份，并在验证失败时按 journal 逆序恢复；
- 若官方 public Interface 无法证明某项恢复安全，则该 capability 保持 disabled，不回退到未审计的直接文件改写。

P15 的第一项工作是把官方 `0.1.1-rc.2` 的可写 Interface 和 storage fingerprint 固化为 fixture/契约测试；计划不以当前本机 `node_modules` 作为运行依赖。

## 4. 事务状态与不可变性

事务状态固定为：

```text
prepared -> backing-up -> applying -> verifying -> completed
                         └──────────> restoring -> restored
                                             └──> restore-failed -> manual-review
```

- 每次 `apply` 在写入前重新读取目标 fingerprint；不一致返回 `PLAN_STALE`，且不创建平台 mutation。
- `plan.json`、`journal.jsonl`、`backup-manifest.json` 和 `verification.json` 必须逐步落盘；journal 每一行有单调序号和前一行 hash。
- 同一计划重复提交只返回原事务或新建明确的 retry 事务，不重复追加事件。
- 同一 DSH instance root 严格串行写入；读取可以有界并发。
- 正常安全快进由用户点击即可执行；删除、显式重置和恢复要求一次性、短期、绑定操作 hash 的 confirmation nonce。
- `Checkpoint` 是用户命名的跨 ref 恢复点，不是每次同步自动生成的环境节点。创建 Checkpoint 不写平台；恢复 Checkpoint 会生成新计划，不删除之后的版本图。
- 阶段二的 Checkpoint 恢复默认从所选版本**创建新的 DSH 会话分支**并移动受管 ref，不覆盖原 DSH 会话；覆盖式重置留到具有独立高风险契约的后续阶段。
- 未完成事务、Checkpoint、未解决冲突和当前 platform/canonical refs 引用的对象与备份禁止 GC。

## 5. 新目录与依赖方向

```text
dsh-session-maintenance/
├─ apps/
│  ├─ engine/                       # 扩展 write/recovery API 与 CLI
│  └─ dashboard/                    # 独立看板，只依赖 client/UI
├─ packages/
│  ├─ contracts/                    # write/transaction/checkpoint/API DTO
│  ├─ transaction-engine/           # 通用事务深 Module
│  ├─ adapter-dsh/                  # 保留只读 Adapter
│  ├─ adapter-dsh-write/            # Engine 侧 DSH write transport
│  ├─ dsh-host-gateway/             # DSH 内官方服务 Adapter
│  ├─ session-ui/                   # GitGraph、diff、共享 view models
│  ├─ local-api-client/             # Dashboard/插件唯一 API client
│  └─ test-support/                 # 写入 fixture、fault injector
├─ plugins/
│  └─ dsh-session-maintenance/      # host gateway + DSH client 入口
└─ vendor/                          # 经许可证确认的固定 UI 构建输入
```

依赖只允许向下：

```text
DSH client / Dashboard -> local-api-client + session-ui
DSH host plugin         -> dsh-host-gateway
Engine                  -> transaction-engine + adapter-dsh-write + read core
Adapters / transaction  -> contracts + domain/store
```

`session-ui` 不依赖 Engine、DSH、SQLite 或本机路径。`dsh-host-gateway` 不依赖 Dashboard。`adapter-dsh-write` 不依赖某个桌面壳或 EAC。

## 6. 批次和加载边界

施工时只读取规格、本主计划、当前批次计划和当前任务涉及的源码。

| 批次 | 任务 | 计划文件 | 结束门禁 |
| --- | --- | --- | --- |
| A | P14–P16 | [transaction-and-dsh-writer](./2026-08-27-session-maintenance-phase-2-a-transaction-and-dsh-writer.md) | fixture 上安全快进可验证；每个故障点可恢复；分叉零写入 |
| B | P17–P20 | [api-and-dashboard](./2026-08-27-session-maintenance-phase-2-b-api-and-dashboard.md) | CLI/API/UI 同计划语义；版本图和正文按需加载；恢复入口可用 |
| C | P21–P22 | [plugin-and-acceptance](./2026-08-27-session-maintenance-phase-2-c-plugin-and-acceptance.md) | 新插件在正式官方 profile 通过；旧插件仅在确认后卸载 |

完成每个批次后，将实际命令、测试计数、提交和残留风险追加到 `docs/validation/phase-2-progress.md`。

## 7. UI 与性能约束

- Dashboard 视觉和交互对齐 DSH Maintenance，但不调用 Maintenance API、不读取 Maintenance 状态目录。
- 固定 UI 基线仍为 Maintenance 提交 `e0e5c6a142b5cad5439c770c33f636c17c6eecc8` 的 `@linmu/dsh-management-kit@0.1.5`。
- P18 必须先确认许可证。确认后才允许将带来源、commit 和 SHA-256 的 tgz 放入 `vendor/`；无法确认时使用既定 `--dsm-*` 视觉契约重新实现，不复制源码。
- `GitGraphCanvas` 在 `packages/session-ui` 独立实现；Generation 的 Git 图代码只作行为参考，不能带入 Generation/Plugin 业务。
- 概览和会话列表只取摘要；版本图、正文、三方 diff、journal 和 Markdown 按展开/分页加载。
- 默认列表页 `limit <= 50`，graph page `limit <= 100`；取消导航时必须中止未完成正文请求。
- DSH 参数面板只显示可调参数、操作按钮和最近一次按钮的短反馈；长期状态、冲突和恢复全部进入 Dashboard。
- DSH 右键 DOM/客户端适配集中在一个 version-locked Adapter；UI fingerprint 不匹配时只禁用菜单并显示诊断，不影响 Engine 和 Dashboard。

## 8. 公共错误码

第二阶段新增并固定：

```text
DSH_BUSY
WRITE_CAPABILITY_UNAVAILABLE
TRANSACTION_IN_PROGRESS
TRANSACTION_NOT_FOUND
TRANSACTION_NOT_RESTORABLE
BACKUP_INCOMPLETE
BACKUP_CORRUPT
VERIFICATION_FAILED
RESTORE_FAILED
RECOVERY_REQUIRED
CONFIRMATION_REQUIRED
CONFIRMATION_EXPIRED
CONFIRMATION_SCOPE_MISMATCH
UI_CONTRACT_INCOMPATIBLE
```

继续复用 `PLAN_STALE`、`ADAPTER_INCOMPATIBLE`、`UNSTABLE_READ`、`DIVERGED` 和 `LIVE_HOME_FORBIDDEN`。日志和 API 错误不得包含 token、全文正文或未登记路径。

## 9. 公共验证与提交约定

每个任务只执行当前计划列出的目标测试、受影响包的 typecheck/build 和 `git diff --check`，不重复运行整仓回归：

```powershell
pnpm --filter <affected-package> typecheck
pnpm --filter <affected-package> build
pnpm vitest run <target-tests>
git diff --check
```

完整 `pnpm typecheck/build/test` 只在 Batch A、B、C 的结束门禁各运行一次。若公共契约发生变化，再额外运行直接消费者的测试，不扫描无关包。

任务修改报告固定为：

```text
docs/changes/DSH-SESSION-MAINTENANCE-20260827-014.md
...
docs/changes/DSH-SESSION-MAINTENANCE-20260827-022.md
```

阶段二最终增加：

```powershell
pnpm test:phase2
pnpm test:phase2-ui
pnpm verify:clean
pnpm assert:portable
git status --short --branch
```

P22 的正式 profile 验收另有人工门禁，不属于普通 `pnpm test`，不得在 CI 或没有用户确认时运行。

## 10. 阶段二验收索引

| ID | 能力 | 阶段门禁 |
| --- | --- | --- |
| W1 | 事务持久化 | 每步 journal 可重开；hash 链、备份和验证文件可校验 |
| W2 | 写入前复核 | fingerprint 或 Adapter contract 漂移时平台零写入 |
| W3 | DSH Adapter | 仅 `0.1.1-rc.2` 固定 fingerprint 可写；live target 返回 `DSH_BUSY` |
| W4 | 安全快进 | 新建目标、append-only、单边标题/归档均幂等 |
| W5 | 分支保留 | 双方追加、重写和身份冲突只生成 review 计划，平台 hash 不变 |
| W6 | 恢复 | 备份、应用、验证各故障点均得到 `completed`、`restored` 或明确人工处理态 |
| W7 | Checkpoint/GC | 命名恢复点不自动泛滥；受引用对象和备份不可回收 |
| W8 | API | 查询/操作 DTO、nonce、SSE 重连和恢复作业契约通过 |
| W9 | Dashboard | DSH 风格、GitGraph/三方 diff/计划/恢复可用，正文按需加载 |
| W10 | DSH 插件 | 右键、参数面板和 Dashboard 入口共用同一 Engine；UI 漂移 fail closed |
| W11 | 解耦 | clean clone 不含旧 sync、EAC、Maintenance runtime 或本机绝对路径依赖 |
| W12 | 正式验收 | 官方 web profile 可扫描、快进、恢复；确认后才替换旧插件 |

## 11. 阶段二停止条件

- P14–P22 均有独立测试、修改报告和提交。
- fixture 上至少完成一次新建 DSH 目标、一次已有 DSH 会话安全快进、一次验证失败自动恢复和一次进程中断恢复。
- Dashboard、CLI、DSH 菜单对同一个计划显示相同 ID、风险、操作和最终事务结果。
- 分叉测试中任何平台文件、canonical ref 和 last-common ref 均未被静默移动。
- 正式 profile 验收前旧插件保持原状；验收和用户确认完成后，才执行替换并记录可恢复包信息。
- P22 完成后停止，不提前实现 Codex 延续任务或 Codex 原生写入。
