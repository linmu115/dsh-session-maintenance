# Session Maintenance Phase 2 Core Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish P15/P16 on synthetic DSH `0.1.1-rc.2` profiles by adding one version-locked, recoverable Core extension and routing safe Codex-to-DSH writes through P14.

**Architecture:** `DshWriteAdapter` translates normalized history; an authenticated `DshHostGateway` invokes a deep `DshCoreExtension` Module that owns exact rc.2 snapshot, inverse, cache invalidation, and runtime reconciliation. `WriteService` moves Maintenance refs only after the normal DSH reader verifies the committed state.

**Tech Stack:** TypeScript 5.9, Node.js 22, Vitest 3, SQLite transaction store, Node fs/zstd, official DSH `0.1.1-rc.2` contract fixtures.

**Spec:** `docs/superpowers/specs/2026-08-27-dsh-rc2-core-extension-design.md`

## Global Constraints

- Never read or write the formal Codex or DSH homes in tests; use marked synthetic temporary profiles only.
- Support only exact DSH `0.1.1-rc.2`, session v0, workspace v2, projection v3, query schema v8.
- Public DSH services perform forward mutation; locked internal hooks exist only inside the Core extension host adapter for inverse, invalidation, and reconciliation.
- No caller-supplied paths, shell operations, EAC compatibility, process lifecycle, deletion, in-place reset, Dashboard, or formal-profile installation.
- Keep platform format knowledge in DSH adapters and orchestration in Engine.
- Add only the three focused tests named by the spec; run the existing phase-one suite at the batch gate.
- Each task ends with a Markdown change report and one commit.

---

### Task P15A: Add the locked rc.2 Core extension

**Files:**
- Modify: `pnpm-workspace.yaml`, `pnpm-lock.yaml`
- Create: `packages/dsh-core-extension/{package.json,tsconfig.json}`
- Create: `packages/dsh-core-extension/src/{contract,types,extension,rc2-host,index}.ts`
- Create: `packages/dsh-core-extension/test/core-extension.test.ts`
- Create: `packages/test-support/src/dsh-core-fixture.ts`
- Modify: `packages/test-support/src/index.ts`
- Add: `fixtures/dsh/0.1.1-rc.2/core-contract/contract.json`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260827-016.md`
- Modify: `docs/validation/phase-2-progress.md`

**Interfaces:**
- Consumes: exact rc.2 host facts recorded in the design specification.
- Produces: `DshCoreExtension.probe/capture/apply/restore`; `DshCoreHost`; `DshCoreSnapshot`; `Rc2CoreContractObservation`.

- [x] **Step 1: Write the contract and fault-recovery test**

Create one test file with two cases: exact fixture contract enables all six phase-two capabilities, while one source-hash drift returns `ADAPTER_INCOMPATIBLE` and zero host writes; a fault after session mutation followed by `restore` must reproduce the captured digest for session, workspace, projection, coordinator, and query domains.

- [x] **Step 2: Run the focused test and confirm red state**

Run `pnpm vitest run packages/dsh-core-extension/test/core-extension.test.ts`; expect module-resolution failure because the package does not exist.

- [x] **Step 3: Implement the deep Module and fixture host**

Implement exactly:

```ts
interface DshCoreExtension {
  probe(): Promise<DshCoreProbe>;
  capture(request: DshCoreCaptureRequest): Promise<DshCoreSnapshot>;
  apply(request: DshCoreApplyRequest): Promise<DshCoreState>;
  restore(request: DshCoreRestoreRequest): Promise<DshCoreState>;
}
```

`LockedRc2CoreExtension` validates contract/session identity, rejects live targets, delegates host mutations in the spec order, and compares post-restore digest. `Rc2CoreHost` is the only file allowed to know locked private field/method names. The synthetic host records writes and supports one named fault point.

- [x] **Step 4: Verify, report, and commit P15A**

Run the focused test, affected-package typecheck/build, `git diff --check`, write `...016.md`, update progress, and commit `feat: add locked DSH rc2 core extension`.

---

### Task P15B: Route the DSH write Adapter through the Core gateway

**Files:**
- Modify: `packages/adapter-dsh-write/src/{contract,index}.ts`
- Create: `packages/adapter-dsh-write/src/{events,prepared-store,transport,adapter}.ts`
- Replace: `packages/adapter-dsh-write/test/contract.test.ts`
- Create: `packages/adapter-dsh-write/test/adapter-recovery.test.ts`
- Create: `packages/dsh-host-gateway/{package.json,tsconfig.json}`
- Create: `packages/dsh-host-gateway/src/{auth,contract,gateway,index}.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260827-017.md`
- Modify: `docs/validation/phase-2-progress.md`

**Interfaces:**
- Consumes: `DshCoreExtension` from P15A, `PlatformWriteAdapter`, `TransactionBackupStore`.
- Produces: `DshWriteAdapter implements PlatformWriteAdapter`; `DshGatewayClient`; transaction-scoped `DshGatewayToken`.

- [x] **Step 1: Write one Adapter recovery test**

Build a simple normalized user/assistant strict-prefix plan. Assert `prepare` emits contiguous balanced DSH events, `backup` stores one `dsh-core-snapshot`, a post-artifact gateway fault causes P14 restore, and the fixture Core digest equals its original value.

- [x] **Step 2: Run the focused test and confirm red state**

Run `pnpm vitest run packages/adapter-dsh-write/test`; expect missing Adapter/gateway exports.

- [x] **Step 3: Implement event translation, prepared persistence, auth, and Adapter methods**

Reject non-message/tool-import/attachment input before capture. Persist canonical prepared JSON under `transactions/<id>/dsh-prepared.json`. Bind gateway tokens to transaction, plan, instance, and session. Store/retrieve the snapshot only through `TransactionBackupStore`. Map Core state mismatches to stable Maintenance errors.

- [x] **Step 4: Verify, report, and commit P15B**

Run Adapter/Core/transaction focused tests, affected-package typecheck/build, `git diff --check`, write `...017.md`, update progress, and commit `feat: write DSH through recoverable core gateway`.

---

### Task P16: Apply safe fast-forwards and move refs after verification

**Files:**
- Modify: `packages/contracts/src/store.ts`
- Modify: `packages/session-store/src/repository.ts`
- Modify: `packages/session-domain/src/{planner,index}.ts`
- Create: `packages/session-domain/test/planner-write.test.ts`
- Create: `apps/engine/src/write-service.ts`
- Modify: `apps/engine/src/{engine,composition-root}.ts`
- Create: `tests/integration/dsh-safe-fast-forward.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260827-018.md`
- Modify: `docs/validation/phase-2-progress.md`

**Interfaces:**
- Consumes: P14 `TransactionExecutor`, P15B `DshWriteAdapter`, existing discovery and object store.
- Produces: `WriteService.applyPlan/getTransaction/restoreTransaction/createCheckpoint/createCheckpointRestorePlan`; `SessionRepository.advanceVerifiedRefs`.

- [x] **Step 1: Write the planner and one end-to-end fixture test**

Cover safe strict-prefix append plus one-sided title/archive, repeated apply returning the same transaction, and a divergent pair producing a review plan with zero fixture-host writes. After a completed apply, assert the observed DSH head, both `lastCommonVersionId` refs, and canonical ref point to the verified version.

- [x] **Step 2: Run the focused tests and confirm red state**

Run `pnpm vitest run packages/session-domain/test/planner-write.test.ts tests/integration/dsh-safe-fast-forward.test.ts`; expect missing write service/ref transition.

- [x] **Step 3: Implement safe shape validation and WriteService**

Allow only the spec's create, append, title, archive, and no-op shapes. `WriteService` loads immutable source bodies, delegates once to `TransactionExecutor`, rescans the target after `completed`, and calls one SQLite transaction `advanceVerifiedRefs`. Restored or unresolved transactions move no refs.

- [x] **Step 4: Close Batch A, report, and commit P16**

Run the two focused tests, Adapter/Core/transaction focused tests, `pnpm test:phase1`, full typecheck/build, portability gate, and `git diff --check`. Write `...018.md`, update progress, and commit `feat: apply verified Codex to DSH fast forwards`. Stop before P17.
