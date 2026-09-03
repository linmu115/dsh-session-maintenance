# M06 — Minimal MCSF v1 / Alpha2 Acceptance

## Result

The approved eight-breakpoint acceptance matrix passes. This stage adds no
new runtime architecture; it verifies the M00-M05 implementation through the
smallest set of focused synthetic tests.

| Breakpoint | Evidence |
| --- | --- |
| First baseline | A fresh format-family cache materializes every selected MCSF session and records its Canonical Revision. |
| No-change restart | A second run performs zero full/selected body loads and leaves retained session and catalog mtimes unchanged. |
| One-session append | A durable runtime append updates its overlay and then exactly one cached session; the second session remains byte-for-byte untouched. |
| Project/workspace targeting | Schema v16 journals only the member session; Alpha2 rewrites only that session and workspace while preserving the control pair. |
| Tombstone removal | A tombstoned logical session is removed from the native index and projection cache. |
| `other` isolation | `maintenance/other` is ignorable, has no `surfaceOp`, is never emitted as `tool/result`, and its source payload is not replayed. |
| Retained clean stop | The run overlay is deleted after drain/checkpoint/cache refresh, while the verified format-family cache remains. |
| Codex read-only authority | The complete synthetic Codex Home SHA-256 tree digest is identical before and after canonical import and projection-related checks. |

## Focused test set

- `packages/projection-lifecycle/test/persistent-cache.test.ts`
- `packages/projection-lifecycle/test/persistent-lifecycle.test.ts`
- `tests/integration/mcsf-alpha2-delta-targeting.test.ts`
- `packages/adapter-dsh-alpha2/test/codex-tool-projection.test.ts`
- `apps/engine/test/codex-canonical-import.test.ts`

Vitest result: 5 files and 13 tests passed. The final workspace typecheck also
passes for all 25 packages.

## Safety boundary

All files, databases, projections and platform homes used by acceptance were
created under test-owned temporary directories. No real Codex Home, DSH Home,
Launcher profile, remote repository or Maintenance Generation was modified.
