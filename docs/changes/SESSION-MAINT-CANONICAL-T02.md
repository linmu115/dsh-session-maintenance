# T02 — Canonical session and workspace storage

## Scope

This task adds schema v7 and the first canonical-source repositories. It stores
canonical sessions, events, DSH derivation lineage, logical workspaces,
historical aliases, and deletion tombstones. It does not materialize a DSH
projection, attach runtime persistence, or emit P1-P8 runtime status events.

## Changes

- Added migration 007 with `canonical_events`, `session_derivations`,
  `logical_workspaces`, `workspace_memberships`, `session_aliases`, and
  `session_tombstones`.
- Added canonical authority, origin, head, archive, tombstone, and update fields
  to `logical_sessions` while preserving all v6 tables and immutable version
  bodies.
- Left legacy authority and origin fields null instead of guessing ownership.
  The candidate-database migration in T19 will classify them with explicit
  migration evidence.
- Added an immutable cross-session derivation table with a unique operation ID,
  parent-version ownership guard, and maintenance/codex-derived child guard.
- Added one-row-per-session logical workspace membership with monotonic
  revisions.
- Added separate SQLite repositories for canonical records, logical workspaces,
  and historical aliases rather than extending the legacy repository body.
- Added an atomic `createDerivedCanonicalSession` operation: a lineage conflict
  rolls back the newly inserted child session.
- Exposed the canonical repository from the existing repository composition so
  later engine tasks can migrate call sites incrementally.

## Focused verification

Commands:

    pnpm exec vitest run packages/session-store/test/migration-007.test.ts packages/session-store/test/canonical-repository.test.ts packages/session-store/test/repository.test.ts
    pnpm --filter @linmu/dsh-session-store typecheck

Results:

- 3 test files passed.
- 6 tests passed.
- The session-store package typecheck passed.
- A synthetic v6 database upgraded to v7 exactly once.
- The legacy version manifest and `native_mirrors` row remained byte-for-byte
  unchanged.
- Duplicate derivation operation IDs roll back the child session insert.
- Invalid derivation sources are rejected.
- Canonical events are idempotent, aliases resolve, and workspace membership
  keeps a single current row.

## Breakpoint policy

This task only establishes persistence needed by later P1-P8 stages. No runtime
status event is emitted yet. The expected initial failures were the absent v7
migration and absent canonical repository; no production child diagnostic stage
was needed after the focused storage breakpoint passed.

## Safety

- Tests used only explicitly marked synthetic SQLite databases under temporary
  directories.
- No real Codex home, DSH home, Launcher Profile, or active Maintenance database
  was read or written.
- No legacy session body was rewritten and no legacy table was removed.
