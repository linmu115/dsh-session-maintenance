# Session Maintenance Phase 2A Transaction and DSH Writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` task-by-task. Execute P14–P16 serially and stop at the batch gate.

**Goal:** 建立可复用事务 Module，实现官方 DSH `0.1.1-rc.2` 的受控写入 Adapter，并在隔离 fixture 上证明 Codex → DSH 安全快进、分支保留和故障恢复。

**Parent plan:** `2026-08-27-session-maintenance-phase-2-dsh-write-and-ui.md`

## Global Constraints

- 从合并第二阶段计划后的 `main` 新建 `codex/phase-2-dsh-write-and-ui`。
- P14 只能使用 fake write Adapter；P15/P16 只能写带 marker 的临时 DSH home。
- `SessionReadAdapter` 保持只读；任何写入能力必须经过新 `PlatformWriteAdapter` Seam。
- transaction 是唯一 mutation 编排入口；Adapter 不自行移动 canonical/last-common refs。
- P15 必须优先使用官方 DSH service Interface。只有契约测试证明可恢复的 version-locked storage 操作才能进入 Implementation。
- DSH 目标为 live、适配器版本漂移、计划过期、备份不完整或存在未解决事务时，必须在第一笔平台写之前失败。

---

### Task P14: Build the transaction journal, backup store, checkpoints, and protected GC

**Files:**
- Modify: `packages/contracts/src/{model,plans,store,adapters,http,schemas,index}.ts`
- Modify: `packages/session-store/src/{schema,database,repository,index}.ts`
- Create: `packages/session-store/src/migrations/003-transactions.ts`
- Create: `packages/transaction-engine/{package.json,tsconfig.json}`
- Create: `packages/transaction-engine/src/{types,journal,backup-store,lock-manager,confirmation,executor,recovery,index}.ts`
- Create: `packages/transaction-engine/test/{journal,backup-store,executor,recovery,confirmation}.test.ts`
- Modify: `packages/test-support/src/index.ts`
- Create: `packages/test-support/src/fake-write-adapter.ts`
- Create: `docs/validation/phase-2-progress.md`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260827-014.md`

**Interfaces:**
- Produces: parent-plan `PlatformWriteAdapter` and `WriteEngine` DTOs; `TransactionExecutor.apply/restore/recover`; `TransactionRepository`; `ConfirmationService`; `CheckpointRepository`.
- Transaction status: `prepared | backing-up | applying | verifying | completed | restoring | restored | restore-failed | manual-review`.

- [x] **Step 1: Write failing state-machine and crash-recovery tests**

Use `FakeWriteAdapter` with fault points `before-backup`, `after-backup`, `after-first-write`, `before-verify`, `verify-false`, `during-restore`. Assert:

- no `commit` before persisted backup manifest;
- every transition appends one fsynced journal row with monotonic sequence and previous hash;
- stale precondition produces `PLAN_STALE` and zero platform writes;
- `verify-false` runs restore exactly once and ends `restored`;
- process reopen resumes `backing-up/applying/verifying` as verify-or-restore, never blind reapply;
- same plan/apply idempotency key cannot append twice.

Run `pnpm vitest run packages/transaction-engine/test`; expected: FAIL because the package and contracts are absent.

- [x] **Step 2: Add migration 003 and repository operations**

Add strict tables for `transactions`, `transaction_steps`, `backup_manifests`, `confirmation_nonces`, and checkpoint lookup indexes. Store transaction IDs, plan ID/hash, Adapter contract, state, target instance root identity, timestamps and result codes; never store full message bodies in transaction rows.

Repository operations must update transaction state and append the matching step inside one SQLite transaction. Reopening a database at schema 2 applies migration 003 once; a newer schema still fails closed.

- [x] **Step 3: Implement append-only journal and content-addressed backups**

Transaction directory is `transactions/<id>/`. Write `plan.json` before state `backing-up`; backup bytes are stored below `backups/sha256/` with manifest entries `{logicalName,size,sha256,required}`. A backup is usable only if every required object exists and rehashes correctly.

Use same-directory temp files, flush file content, atomic rename, then flush the parent directory where supported. Journal lines contain no conversation text and form a hash chain. A truncated final line is ignored only when every earlier line and SQLite step agree; other disagreement becomes `manual-review`.

- [x] **Step 4: Implement exclusive root locks and confirmations**

`RootWriteLockManager` serializes by registered instance ID plus canonical root identity. It writes an owner record with PID/start token but never steals a lock merely because PID is missing; stale recovery requires journal inspection.

Confirmation nonces are random, single-use, expire after five minutes, and bind `{operation,resourceId,operationHash}`. Safe fast-forward does not require a nonce. Restore, reset and deletion do. API DTOs never expose nonce storage paths.

- [x] **Step 5: Implement executor and restart recovery**

Executor order is fixed:

```text
load plan -> re-probe Adapter -> re-read fingerprints -> acquire root lock
-> persist transaction -> prepare -> backup -> commit -> verify
-> update repository refs only after verification
```

If commit may have started but completion is unknown, recovery first calls Adapter verify. Matching expected state completes; matching backup state records restored; any third state requires explicit restore or manual review. It never replays commit based only on an incomplete journal.

- [x] **Step 6: Implement named checkpoints and protected collection**

Checkpoint creation records explicit logical/platform/canonical refs plus referenced completed transaction backups. It creates no automatic per-apply checkpoint. Checkpoint restore produces a new immutable plan and requires confirmation at apply time. In phase two, that plan creates a new DSH session from the selected version and preserves the current DSH session as another branch; it never rewrites the old log in place.

Extend reachability so unresolved transactions, checkpoint refs, checkpoint backup IDs and current refs protect content and backups. GC returns a dry-run reason per retained/deletable item.

- [x] **Step 7: Verify, report, and commit P14**

Cover corrupted backup, journal/database disagreement, two concurrent writes to one root, parallel writes to different roots, expired/replayed/wrong-scope nonce, checkpoint reopen and GC protection. Run P14 target/affected-package validation, write `...014.md`, update `phase-2-progress.md`, and commit `feat: add recoverable write transactions`.

---

### Task P15: Implement the official DSH 0.1.1-rc.2 write Adapter

**Files:**
- Modify: `packages/adapter-dsh/src/{probe,reader,index}.ts`
- Create: `packages/adapter-dsh-write/{package.json,tsconfig.json}`
- Create: `packages/adapter-dsh-write/src/{contract,transport,adapter,index}.ts`
- Create: `packages/adapter-dsh-write/test/{contract,adapter,restore}.test.ts`
- Create: `packages/dsh-host-gateway/{package.json,tsconfig.json}`
- Create: `packages/dsh-host-gateway/src/{context,auth,contract,session-writer,workspace-writer,backup,apply,index}.ts`
- Create: `packages/dsh-host-gateway/test/{contract,session-writer,workspace-writer}.test.ts`
- Modify: `packages/test-support/src/{dsh-fixture,index}.ts`
- Add: `fixtures/dsh/0.1.1-rc.2/write-contract/**`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260827-015.md`

**Interfaces:**
- Produces: `DshWriteAdapter implements PlatformWriteAdapter`; `DshHostGateway.prepare/backup/commit/verify/restore`; contract `dsh-write/0.1.1-rc.2/<fingerprint>`.
- DSH gateway capabilities are granular: `create-session`, `append-events`, `update-title`, `update-archive`, `verify`, `restore`.

- [ ] **Step 1: Capture and lock the official write contract**

From the installed official packages and the matching upstream release, record only public Interface facts required by the Adapter: `sessionPersistence`, `sessions`, `workspaceRegistry`, title/projection/storage services, session v0 header, event envelope and archive representation. Build synthetic fixtures; do not copy user sessions.

Compute a deterministic fingerprint from package versions, exported method/type surface, session header version and relevant storage domain versions. Add a test proving `0.1.1-rc.2` matches and a one-field drift returns `ADAPTER_INCOMPATIBLE` with zero writes.

If a required restore operation has no supportable public or version-locked Implementation, disable only that capability and stop P15; do not add a generic raw-file fallback.

- [ ] **Step 2: Define a narrow authenticated host protocol**

Gateway accepts only Engine-created transaction IDs, plan hashes, registered session/workspace IDs and normalized operation DTOs. It rejects paths, shell commands, unknown event types and expired transaction tokens. Token is short-lived and scoped to one transaction; the browser never receives it.

Transport supports `probe`, `prepare`, `backup`, `commit`, `verify`, `restore` and `status`. The Engine Adapter maps transport failures to stable error codes and contains all retry policy.

- [ ] **Step 3: Implement preflight and candidate preparation**

Preflight checks the exact DSH contract, target existence, target not live, stable persistence revision, workspace mapping, free space, no root lock conflict and operation compatibility. `prepare` converts normalized Codex message events to the exact supported DSH event subset in a staging object without mutating DSH.

Unsupported Codex/DSH tool semantics produce `WRITE_CAPABILITY_UNAVAILABLE`; they are not forged as native DSH tool calls. Creating a target requires an explicit workspace mapping/cwd and generates a fresh DSH session ID.

- [ ] **Step 4: Implement official-service writes and complete backups**

Use official DSH service Interfaces for creation, append, title and archive. Back up every mutable artifact/domain involved by the selected operations, including session artifact/revision and any title, archive, workspace or projection state that cannot self-heal from the authoritative log.

The backup manifest names logical artifacts rather than accepting paths from callers. A write is refused when a complete backup cannot be obtained. Projection cache is never treated as the source of truth, but its rollback behavior must be tested.

- [ ] **Step 5: Implement verification and reverse restore**

Verification uses the existing `DshReadAdapter` after the gateway reports durable completion. It proves target discovery, event prefix, title/archive, workspace mapping and expected fingerprints. Restore runs journal steps in reverse, verifies backup hashes, restores every modified domain, and re-reads through the public Interface.

Any in-memory/live state that cannot be invalidated safely yields `DSH_BUSY` before commit; it is not repaired by killing DSH or coupling to a desktop shell.

- [ ] **Step 6: Test platform faults and zero-live-home access**

Cover target live, changed persistence revision, unknown header, unsupported event, workspace mismatch, projection failure, partial append, archive failure, verify mismatch and restore failure. All tests use marked temporary homes and assert no call reaches the formal profile.

- [ ] **Step 7: Verify, report, and commit P15**

Run Adapter/gateway target/affected-package validation. Record the exact supported fingerprint and disabled capability list in `...015.md`, update progress, and commit `feat: write official DSH sessions safely`.

---

### Task P16: Apply Codex-to-DSH fast-forward and preserve divergent branches

**Files:**
- Modify: `packages/session-domain/src/{planner,diff,index}.ts`
- Modify: `packages/session-store/src/repository.ts`
- Modify: `apps/engine/src/{engine,composition-root}.ts`
- Create: `apps/engine/src/write-service.ts`
- Modify: `apps/engine/src/jobs/{job-runner,job-store}.ts`
- Test: `packages/session-domain/test/planner-write.test.ts`
- Test: `tests/integration/{dsh-safe-fast-forward,dsh-branch-preservation,dsh-write-recovery}.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260827-016.md`

**Interfaces:**
- Produces: `WriteService.applyPlan/getTransaction/restoreTransaction/createCheckpoint/createCheckpointRestorePlan`; persistent `apply` and `restore` jobs.

- [ ] **Step 1: Write failing end-to-end fixture tests**

Create cases for: missing DSH target, existing DSH strict prefix, source-only title, source-only archive, equal/no-op, DSH target ahead, both sides appended, rewritten target and repeated apply. Assert only the first four create write operations; conflict cases preserve both heads and platform hashes.

- [ ] **Step 2: Finalize writable plan semantics**

Every writable operation includes enough source version/event IDs for the Adapter to retrieve immutable bodies from the object store, but `SyncPlan` itself does not duplicate full text. `create-target-session` includes registered workspace mapping ID, not a filesystem path.

Only these plan shapes are phase-two writable:

```text
create-target-session (+ append initial events)
append-events
update-title
update-archive
append-events + one-sided metadata updates
```

`target-ahead` is observed only; `diverged`, `rewritten`, dual metadata change, identity conflict and deletion remain review/destructive and are not executable in phase two.

A Checkpoint recovery is represented as `create-target-session` from the selected immutable version plus an explicit post-verification ref move. It is not an in-place reset and cannot delete or rewrite the newer DSH branch.

- [ ] **Step 3: Integrate TransactionExecutor into the Engine**

`WriteService` resolves plan and registered instances, validates source/target bindings and delegates exactly once to TransactionExecutor. Job runner persists apply/restore jobs; on restart, only Transaction recovery decides verify/restore. Scan jobs continue to be safely requeued.

- [ ] **Step 4: Move refs only after successful verification**

After verification, observe the target through the normal discovery path, then atomically update `lastCommonVersionId` and the logical session canonical ref according to policy. Transaction receipt records resulting version/ref IDs. `restored`, `restore-failed` and stale plans move none of these refs.

Repeated apply of a completed plan returns its completed transaction and does not create duplicate DSH events or versions.

- [ ] **Step 5: Add fault injection at every write boundary**

Inject failures before/after backup, before first mutation, between operations, before/after durable commit, during read verification and each restore step. Expected terminal result must be one of `completed`, `restored`, `restore-failed`, or `manual-review`; plain `failed` after possible mutation is forbidden.

- [ ] **Step 6: Close batch A**

Run P14–P16 tests, `pnpm test:phase1`, common validation and a platform-tree hash comparison. Write `...016.md`, update progress, and commit `feat: apply Codex to DSH fast forwards`. Stop before P17.

## Batch A Gate

- DSH strict-prefix apply succeeds and verifies on a marked `0.1.1-rc.2` fixture.
- Same plan twice produces no duplicate event.
- Every injected post-mutation fault either restores fully or enters an explicit non-writable recovery state.
- Diverged/rewritten cases produce zero DSH writes and preserve both version branches.
- No EAC, shell lifecycle, old sync plugin or live-home path appears in production dependencies.
