# T05 — Canonical migration preview

## Scope

This task implements Gate A: a read-only explanation of how legacy v6 sessions
would map into the canonical source model. It does not copy a database, create a
candidate, migrate a row, switch an active pointer, or change a source file.

## Changes

- Added shared migration preview DTOs for source-file digests, candidate and
  rollback information, category counts, per-session disposition, reason codes,
  proposed IDs, and legacy workspace evidence.
- Added `previewCanonicalMigration`, which reads legacy `logical_sessions`,
  `native_mirrors`, and `binding_workspaces` through the already-open database
  connection.
- Added explicit classification for:
  - Codex-only → `codex-mirror`;
  - DSH-only → `maintenance-native`;
  - equal → one `codex-mirror`;
  - Codex/source ahead → the same `codex-mirror`;
  - DSH/target ahead → one mirror plus one deterministic derived-child proposal;
  - diverged → `review-required` with no proposed session IDs;
  - absent/incomplete mirror evidence → `unclassified`.
- Added before/after SHA-256 verification for the source SQLite database and any
  existing WAL/SHM sidecars. The preview fails if any source byte changes.
- Added an authenticated read-only Dashboard API endpoint at
  `GET /v1/migrations/canonical/preview`.
- Added candidate path and rollback strategy reporting while directly asserting
  that the candidate file is not created.

## Focused verification

Commands:

    pnpm exec vitest run packages/session-store/test/canonical-migration-preview.test.ts apps/engine/test/canonical-migration-preview.test.ts
    pnpm --filter @linmu/dsh-session-store typecheck
    pnpm --filter @linmu/dsh-session-maintenance-engine typecheck
    pnpm --filter @linmu/dsh-session-contracts typecheck

Results:

- 2 test files and 2 tests passed.
- All three modified packages passed typecheck.
- The synthetic v6 fixture contained Codex-only, DSH-only, equal, source-ahead,
  target-ahead, diverged, and one unclassified session.
- Counts were 4 Codex mirrors, 1 Maintenance-native session, 1 derived-child
  proposal, 1 review-required session, and 1 unclassified session.
- Diverged history produced no automatic merge or split IDs.
- The source database digest remained identical and the candidate path remained
  absent after both store and HTTP previews.

## Gate A

- Migration preview is explainable: passed.
- Ambiguous divergence is not auto-merged: passed.
- Source database receives zero preview writes: passed.

## Breakpoint policy

Only the storage classifier and authenticated API boundary were tested. Their
stable results were sufficient for Gate A, so no deeper per-query diagnostic
breakpoint or runtime P1-P8 event was added.

## Safety

- The v6 database was synthetic and stored in a marked temporary directory.
- The Engine API test used the existing fixture sandbox.
- No real Codex home, DSH home, Maintenance database, Launcher Profile, or
  Generation was read or written.
