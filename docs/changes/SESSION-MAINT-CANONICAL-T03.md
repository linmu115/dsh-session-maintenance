# T03 — Projection runtime persistence

## Scope

This task adds schema v8 and repositories for projection runs, writer leases,
operation receipts, adapter registrations, verification records, and structured
P1-P8 status events. It persists runtime coordination state but does not start a
DSH process, materialize a projection, or attach `sessionPersistence`.

## Changes

- Added `adapter_registrations` and `adapter_verification_runs` for explicit
  Adapter package manifests and version verification evidence.
- Added `projection_runs`, `projection_sessions`, and `projection_workspaces`
  for temporary per-run native mappings.
- Added a partial unique index that permits only one active writer lease per
  branch while retaining room for future independent branch runs.
- Added `run_operations` with globally unique operation IDs and immutable,
  idempotent operation receipt payloads.
- Added `run_status_events` with a monotonic per-run sequence and indexes for
  run, logical session, operation, stage, span, and time queries.
- Extended `StatusEventQuery` with `spanId`; the stable P1-P8 stage set and
  started/succeeded/failed state set remain unchanged.
- Added separate projection-run, status-event, and adapter-registry
  repositories.
- Made migration 007 and 008 tests execute their exact migration rather than
  tracking whatever the latest schema becomes in later tasks.

## Focused verification

Commands:

    pnpm exec vitest run packages/session-store/test/migration-008.test.ts packages/session-store/test/projection-run-repository.test.ts
    pnpm --filter @linmu/dsh-session-store typecheck
    pnpm --filter @linmu/dsh-session-contracts typecheck

Regression fixture commands:

    pnpm exec vitest run packages/session-store/test/repository.test.ts packages/session-store/test/migration-007.test.ts

Results:

- T03: 2 test files and 3 tests passed.
- Focused migration regression: 2 test files and 4 tests passed.
- Both modified packages passed typecheck.
- A second active writer on the same branch is rejected, while a different
  branch may acquire its own lease.
- Closing the first run releases the branch for a later writer.
- Replaying the same operation ID keeps the exact same receipt.
- Status events preserve chronological order and can be filtered by span, run,
  logical session, operation, and stage.

## Breakpoint policy

T03 persists the status-log channel but does not emit fabricated runtime stages.
The test sequence models one real `session.append.commit` span with only
`started` and `succeeded`. No child diagnostic stage was added because the
stable storage breakpoint passed. DDL-heavy synthetic migration tests have an
explicit 15-second test-only ceiling to avoid Windows parallel-I/O false
timeouts; product timeouts are unchanged.

## Safety

- All databases were synthetic fixtures in marked temporary directories.
- No real Codex or DSH home, Launcher Profile, projection directory, or active
  Maintenance database was read or written.
- Schema v8 only adds runtime tables; v7 canonical-source rows remain intact.
