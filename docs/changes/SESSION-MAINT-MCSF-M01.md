# M01 — Canonical Change Journal

## Outcome

- Maintenance schema v12 now owns a monotonically increasing, lightweight
  `canonical_change_log`.
- A caller can request `listChanges({ afterRevision, limit })` and receive only
  revision, logical session ID, change class and timestamp. No session body,
  message, tool payload or token is returned.
- Existing MCSF sessions receive one `session-created` baseline row during the
  migration. The migration does not scan or rewrite their event bodies.
- Content, metadata, workspace, project, branch and tombstone changes create
  journal entries. Replaying an identical event or membership does not create a
  new revision.

## Module boundary

- Contracts define `CanonicalChangeV1`, `CanonicalChangeQuery` and
  `CanonicalChangePage`.
- Session Store owns the journal schema, triggers and paged query.
- Projection Lifecycle does not consume the journal yet; that is M04 after the
  Adapter Evidence and Native Session Reference tasks.
- No Adapter, Launcher or DSH plugin behavior changed in this task.

## Efficient query semantics

- `revision` is the SQLite monotonic key and is the only startup cursor.
- Pages are capped at 1,000 journal rows.
- `currentRevision` is snapshotted before the page query.
- `throughRevision` is the last returned revision, allowing a caller to resume
  without rescanning earlier rows.
- Callers may coalesce repeated logical session IDs before materialization.
- A cursor newer than Maintenance is rejected instead of silently pretending
  that the projection is current.

## Breakpoint

`canonical.change-journal` is represented by the page receipt:

- `afterRevision`
- `throughRevision`
- `currentRevision`
- returned row count
- distinct logical session count (computed by the consumer)

It never contains canonical event bodies.

## Focused verification

- `pnpm exec vitest run --maxWorkers=1 --testTimeout=20000 packages/contracts/test/canonical-projection-contracts.test.ts packages/session-store/test/migration-012.test.ts packages/session-store/test/repository.test.ts packages/session-store/test/migration-009.test.ts packages/session-store/test/migration-010.test.ts packages/session-store/test/migration-011.test.ts tests/integration/canonical-migration-activation.test.ts`
- Result: 7 files, 14 tests passed.
- Contracts and Session Store focused typechecks passed.

All migration and repository checks use temporary synthetic databases. No real
Codex Home, DSH Home, Launcher Profile, projection directory or active
Maintenance database was opened or modified.
