# Codex strict project import and continuous observation

The Engine import entry accepts an optional native project scope provider. An undefined scope preserves the pre-configuration import behavior; an explicit empty project list imports no sessions. Configured membership comes exclusively from the adapter's native project directory. Project name collisions, shared roots and identical working directories do not expand the selected set.

## Import boundaries

- Scoped adapters receive the selected native thread IDs before probing or listing. The scoped probe checks schema without loading a sample rollout; unrelated missing or invalid rollout paths cannot trigger body reads or block the selected import.
- Canonical project assignments use the native desktop project ID, name and roots. A session's independent workspace metadata remains intact and never determines project membership.
- The planner records the source instance and scope revision/selection. Scope and native membership are checked immediately before body observation, after any head lookup, and again inside the canonical write queue before committing. Detached scoped plans require a scope provider when applied. Revision changes, migration ownership changes, unsafe directories and cancellation fail closed.
- Title-only foreground imports use the same selected membership and revalidate it inside the write queue. Import jobs, retries and online tooling share this entry point; offline script policy wiring is covered by the separate composition work.

## Observer behavior

`CodexProjectObserver` exposes `start()`, `stop()`, deterministic `tick()` and `snapshot()`. Snapshot state includes `state`, `lastSyncAt` and `lastError`. The default delay is two seconds after a completed pass; configured bounds are 250 milliseconds to 60 seconds. Concurrent ticks share one pass. Stop aborts and awaits active work, and lifecycle generations prevent an older waiting start or timer from reviving a stopped observer.

Only active configured scopes are observed. A scope disappearing during background dispatch fails closed instead of falling back to legacy import. Each pass refreshes native membership, allowing future tasks in a selected project to enter automatically. Removed membership and observer restart invalidate the cache.

The adapter's full metadata/file stamp and body stamp detect append, truncation, replacement, archive and workspace changes. Unchanged sessions perform no body observation or canonical commit. A title or update timestamp change with the same body stamp uses a guarded title commit and preserves the body cursor. Titles come from the same metadata capture as their stamp. Cache entries are saved only when the post-commit source stamp still matches the pre-read stamp. Adding another native member does not invalidate existing members' body cache. An unchanged pass performs three native directory reads independent of selected session count.

## Fixture validation

All tests use marked synthetic homes. No test reads or writes a real Codex home. The selected-import fixture verifies that every source file hash remains unchanged.

- `pnpm --filter @linmu/dsh-session-maintenance-engine typecheck` — passed.
- `codex-project-scope.test.ts` — 16 tests passed, covering strict filtering with identical names/roots/cwd, explicit empty scope, scope/native-membership races, detached plans and replay, cancellation, scoped title repair, unsafe directories, future member discovery, title-only body avoidance, append/truncation/replacement/restart invalidation, constant directory read count, non-overlap and lifecycle stop/start races.
- Existing `codex-import-jobs.test.ts`, `codex-canonical-import.test.ts` and `codex-catalog-title-sync.test.ts` — 11 tests passed, including authenticated HTTP jobs, online CLI import, deduplication, queue cancellation/resume, source-head races, shutdown recovery and legacy unconfigured behavior.

Foreground imports retain their streaming per-session behavior. Startup activation must provide an outer transaction if it requires all imported sessions and the active policy to become visible together; the composition owner implements that activation boundary separately.
