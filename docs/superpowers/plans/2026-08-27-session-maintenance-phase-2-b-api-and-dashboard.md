# Session Maintenance Phase 2B API and Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` task-by-task. Execute P17–P20 serially and stop at the batch gate.

**Goal:** 把批次 A 的写入、Checkpoint 和恢复能力完整暴露给 CLI/受限本地 API，并实现与 DSH Maintenance 对齐的独立 Dashboard。

**Parent plan:** `2026-08-27-session-maintenance-phase-2-dsh-write-and-ui.md`

## Global Constraints

- 仅在 Batch A Gate 通过后执行。
- 先完成 CLI/Engine/API 的 Operation，再做对应 GUI；GUI 不拥有第二套业务状态机。
- API 只接受已登记 ID、计划 ID、事务 ID和分页游标；禁止 root/path/home/cwd。
- 浏览器只获得受限 Dashboard session，不获得 Engine capability token 或 DSH gateway token。
- 首屏不读取正文、全部版本、全部 journal 或全部 Markdown。
- 阶段三/四功能在界面中明确 unavailable，不创建无效作业。

---

### Task P17: Complete operation DTOs, CLI/API commands, pagination, and event delivery

**Files:**
- Modify: `packages/contracts/src/{http,jobs,schemas,model,plans,index}.ts`
- Modify: `packages/local-api-client/src/{client,event-stream,index}.ts`
- Modify: `apps/engine/src/{cli,engine,composition-root}.ts`
- Modify: `apps/engine/src/http/{auth,body,routes,server,sse}.ts`
- Create: `apps/engine/src/http/{ui-session,static-dashboard}.ts`
- Modify: `apps/engine/src/jobs/{job-runner,job-store}.ts`
- Test: `packages/local-api-client/test/{client,event-stream}.test.ts`
- Test: `apps/engine/test/{cli,http-api,job-runner}.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260827-017.md`

**Interfaces:**
- Produces: complete `SessionMaintenanceClient`; operation jobs for apply/restore; checkpoint, transaction, diagnostics and settings DTOs.

- [ ] **Step 1: Write failing transport parity tests**

For each operation, call CLI, authenticated HTTP and typed client against the same fixture and compare normalized results. Include scan, diff, plan, apply, transaction detail, restore, checkpoint create/list, checkpoint restore-plan, Adapter diagnostics and settings.

Assert request bodies containing `path`, `root`, `home`, `cwd`, unknown keys or over-limit text return `400`; missing/wrong token returns `401`; malicious Origin returns `403`.

- [ ] **Step 2: Fix the route and command surface**

```text
CLI
  transaction apply|get|restore|recover
  checkpoint create|list|plan-restore
  diagnostics adapters
  settings get|set

HTTP
  GET  /v1/sessions/:id
  GET  /v1/sessions/:id/graph
  GET  /v1/sessions/:id/versions/:versionId
  POST /v1/plans/:id/apply
  GET  /v1/transactions
  GET  /v1/transactions/:id
  POST /v1/transactions/:id/restore
  GET|POST /v1/checkpoints
  POST /v1/checkpoints/:id/restore-plan
  POST /v1/bindings/:id/unmap
  GET  /v1/diagnostics/adapters
  GET|PATCH /v1/settings
```

Commands accepting local instance paths remain trusted CLI-only and are not reused as HTTP DTOs.

- [ ] **Step 3: Add bounded pagination and lazy content DTOs**

Session summaries contain counts/status only. Graph nodes contain identity, parents, source, timestamp, small labels and compatibility; body/version note is a separate endpoint. Transactions list only state/operation counts; journal and backup details load on demand.

Use opaque signed cursors with fixed sort keys. Reject `limit > 100`; default session list is 50. Version body responses have a configurable maximum and explicit `CONTENT_TOO_LARGE`, never silent truncation.

- [ ] **Step 4: Harden jobs, confirmations, and SSE resume**

Apply/restore jobs include plan/transaction ID but no content. SSE supports `Last-Event-ID`, emits ordered persisted events and closes after terminal status. Reconnect cannot replay a mutation; it only replays job events.

Add confirmation creation/consumption endpoints only for operations whose DTO schema declares it. Return a short-lived nonce exactly once and redact it from logs.

The trusted CLI/DSH host may exchange the long-lived Engine capability for a one-time Dashboard launch code. Claiming that code sets a short-lived `HttpOnly`、`SameSite=Strict` UI session cookie and redirects to a fixed Dashboard route. Browser operations require that cookie, the exact Dashboard Origin and a per-session CSRF header; the browser never reads the Engine capability or DSH gateway token. Launch codes are one-use, expire quickly and cannot carry arbitrary redirect URLs.

- [ ] **Step 5: Verify, report, and commit P17**

Cover pagination stability during concurrent scans, cancelled body request, SSE reconnect, replayed nonce, API restart with running write transaction, and client error mapping. Run P17 target/affected-package validation, write `...017.md`, update progress, and commit `feat: expose session write operations safely`.

---

### Task P18: Build the DSH-style Dashboard shell and shared UI baseline

**Files:**
- Modify: `pnpm-workspace.yaml`, root `package.json`, `pnpm-lock.yaml`
- Create: `apps/dashboard/{package.json,tsconfig.json,vite.config.ts,index.html}`
- Create: `apps/dashboard/src/{main,App,routes,client,styles}.tsx`
- Create: `apps/dashboard/src/pages/{OverviewPage,SessionsPage}.tsx`
- Create: `packages/session-ui/{package.json,tsconfig.json}`
- Create: `packages/session-ui/src/{index,view-models,status,layout,markdown}.tsx`
- Create: `packages/session-ui/test/{status,view-models}.test.tsx`
- Create: `vendor/README.md`, conditional `vendor/dsh-management-kit-0.1.5.tgz`
- Create: `docs/third-party/dsh-management-kit.md`
- Test: `apps/dashboard/test/{shell,sessions-lazy}.test.tsx`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260827-018.md`

**Interfaces:**
- Produces: standalone Dashboard shell, route model, shared status/empty/error/Markdown components and API query hooks.

- [ ] **Step 1: Resolve the UI license gate**

Check Maintenance commit `e0e5c6a142b5cad5439c770c33f636c17c6eecc8`, package metadata and repository license. Record source commit, package version, author/license conclusion and SHA-256.

Only if redistribution is confirmed, build a clean tgz and place it in `vendor/`; add required notices. If not confirmed, do not copy package sources or tarball. Implement the already-approved visual contract independently with `--dsm-*` compatible variables and document that choice. This decision must be committed before UI code imports the kit.

- [ ] **Step 2: Write failing shell/lazy-load tests**

Render Overview and Sessions with a fake `SessionMaintenanceClient`. Assert Overview requests only health/instance/summary counts; Sessions requests one summary page; neither requests version bodies or graph pages. Verify loading, empty, incompatible and Engine-offline states.

- [ ] **Step 3: Implement the shared shell**

Use sticky top navigation and routes for `概览`, `会话`, `计划`, `事务与恢复`, `设置`. Align typography, surfaces, compact controls, success/info/warning/danger semantics, focus rings and narrow-window behavior with DSH Maintenance.

The shell receives only a cookie-authenticated typed client. It does not read connection files, environment variables, long-lived tokens, local storage databases or platform files.

- [ ] **Step 4: Implement Overview and Sessions pages**

Overview shows registered platforms, Adapter compatibility, pending safe plans, conflicts and unresolved transactions. Sessions supports platform/workspace/status/update-time filters, cursor pagination and stable URLs. Counts are links to filtered lists rather than duplicated business calculations.

Do not display future mirror counters as active features in phase two.

- [ ] **Step 5: Add Markdown and shared view models**

Provide sanitized GFM rendering for version notes, Checkpoint descriptions and diagnostic help. Raw HTML, external script/image injection and unsafe protocols are disabled. Shared view models map stable error/status codes to concise Chinese labels and recommended actions.

- [ ] **Step 6: Verify, report, and commit P18**

Run UI unit tests, production build, bundle inspection and accessibility checks for keyboard navigation/labels. Assert no runtime import from Maintenance and no token in browser bundle. Write `...018.md`, update progress, and commit `feat: add session maintenance dashboard shell`.

---

### Task P19: Add the session GitGraph workbench, three-way diff, plan preview, and Checkpoints

**Files:**
- Create: `packages/session-ui/src/{GitGraphCanvas,graph-layout,ThreeWayDiff,PlanPreview,CheckpointEditor}.tsx`
- Test: `packages/session-ui/test/{graph-layout,three-way-diff,plan-preview}.test.tsx`
- Create: `apps/dashboard/src/pages/{SessionDetailPage,PlansPage,CheckpointsPage}.tsx`
- Modify: `apps/dashboard/src/{App,routes,styles}.tsx`
- Test: `apps/dashboard/test/{session-detail,plan-flow,checkpoint-flow}.test.tsx`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260827-019.md`

**Interfaces:**
- Produces: reusable graph/diff/plan view components and session workbench routes.

- [ ] **Step 1: Write failing graph and diff tests**

Cover linear history, two platform heads, merge base, two-parent resolution node, pagination boundary and 1,000-node virtualized graph. Node order must be deterministic and branch lanes stable across incremental page loading.

Three-way diff distinguishes common ancestor, Codex-only append, DSH-only append, metadata-only change, rewritten event and unsupported imported event. It never presents divergent conversations as one chronological stream.

- [ ] **Step 2: Implement one reusable workbench template**

Session detail uses a resizable left GitGraph and right local top tabs: `概览`, `版本内容`, `三方差异`, `操作`. Left width persists as a UI preference and is clamped for narrow windows. Selecting a node updates the URL and lazy-loads only that version.

`GitGraphCanvas` is a session-specific Implementation in `packages/session-ui`; it does not import the Maintenance Generation graph.

- [ ] **Step 3: Implement plan preview and apply flow**

Plan Preview shows source/target/base, exact operation list, target Adapter, preconditions, risk, expected final refs and unavailable reasons. Safe apply is a deliberate button. Review plans have no apply button. Restore/destructive plans request scoped confirmation only after a second preview.

After submission, UI follows the job stream and links to the resulting transaction. Refresh/reconnect never resubmits.

- [ ] **Step 4: Implement Checkpoint pages**

Users can name a Checkpoint, edit/render Markdown description, select explicit logical/platform refs and inspect protected transaction backups. No Checkpoint is auto-created by normal sync.

Restore first creates a new previewable plan. Phase two explains that it creates a new DSH session branch from the saved version and preserves the current branch; it does not offer an in-place overwrite. “建立 Checkpoint” and “恢复 Checkpoint” use distinct wording and actions.

- [ ] **Step 5: Verify, report, and commit P19**

Test graph keyboard navigation, resizer, deep-link restore, stale plan refresh, no-op plan, conflict read-only state, duplicate-click idempotency and Checkpoint create/restore preview. Write `...019.md`, update progress, and commit `feat: visualize session history and plans`.

---

### Task P20: Add transaction recovery, Adapter diagnostics, and settings

**Files:**
- Create: `apps/dashboard/src/pages/{TransactionsPage,TransactionDetailPage,DiagnosticsPage,SettingsPage}.tsx`
- Create: `packages/session-ui/src/{JournalTimeline,RecoveryPanel,AdapterReport,SettingsForm}.tsx`
- Test: `packages/session-ui/test/{journal,recovery,settings}.test.tsx`
- Test: `apps/dashboard/test/{recovery,diagnostics,settings}.test.tsx`
- Modify: `apps/dashboard/src/{App,routes,styles}.tsx`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260827-020.md`

**Interfaces:**
- Produces: recovery/diagnostic/settings UI over P17 DTOs; no new business rules.

- [ ] **Step 1: Write failing recovery and settings tests**

Render completed, restored, restore-failed, manual-review and Engine-restarted transactions. Assert only restorable states expose Restore; confirmation scope equals displayed transaction/hash; unknown state disables all mutation buttons.

Settings tests cover instance selection, workspace mapping, title sync, scan scope, backup retention and safe-batch preference. They never submit arbitrary paths from the browser.

- [ ] **Step 2: Implement journal and recovery views**

Transaction list is paged and summary-only. Detail lazily loads journal, verification and backup manifest. Show step names, timestamps, hashes/sizes and non-technical failure explanation without body text or raw private paths.

Recovery submits the exact transaction ID plus confirmation and follows a new job. `manual-review` provides exportable diagnostic metadata but no “continue anyway”.

- [ ] **Step 3: Implement Adapter diagnostics**

Show registered platform version, contract fingerprint, supported/disabled capabilities, last contract test and actionable incompatibility reason. Do not expose runtime token or filesystem paths. DSH write unavailable leaves scanning/history usable.

- [ ] **Step 4: Implement settings with server-side instance IDs**

Dashboard can select registered Codex/DSH instances, workspace mapping IDs, title/archival policy, scan scope, backup retention and batch-safe-apply. Adding/changing actual roots remains CLI/installer-only.

Codex continuation, native mirror and Codex write controls are visibly labeled as future-stage unavailable and cannot be persisted as active.

- [ ] **Step 5: Close batch B**

Run API/client tests, UI tests, production build, Playwright smoke on a fixture Engine, phase-one regressions and common validation. Write `...020.md`, update progress, and commit `feat: add transaction recovery dashboard`. Stop before P21.

## Batch B Gate

- CLI、HTTP、typed client 和 Dashboard 对同一 plan/transaction 返回一致身份与结果。
- Dashboard 首屏和列表正文请求数为 0；图、正文、journal 均按需加载。
- Safe、review、destructive/recovery 操作在 UI 上有不同且不可绕过的交互。
- Browser bundle 不含 Engine/gateway token、任意本机路径或 Maintenance runtime import。
- `pnpm test:phase1` 继续通过。
