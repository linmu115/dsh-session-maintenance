# Codex read-only authority boundary

Date: 2026-09-02

## Removed capability

Commit `3fe7d34` originally added per-session native mirror controls. Its
production CLI enabled `CodexNativeWriteAdapter` by default, including inside
the composition named `createReadOnlyComposition`. A Codex-targeted applied
plan could consequently replace a real Codex rollout, `session_index.jsonl`
and `state_5.sqlite`, and could remove SQLite WAL/SHM files.

That capability conflicts with the canonical projection architecture. Codex
owns its session truth; Maintenance may observe stable Codex snapshots and
incrementally import them, but it must never publish changes into the Codex
home.

The production Engine no longer imports, constructs or depends on the native
Codex write adapter. The adapter package itself has been removed. DSH write
handling remains limited to the explicit DSH gateway composition, while the
standard server composition has no platform writer.

## Preserved behavior

- Stable, query-only reads of Codex `state_5.sqlite`.
- Stable rollout streaming and incremental canonical import.
- Codex title, project and workspace assignment import.
- Alpha2 materialization into a run-scoped temporary projection.
- First DSH continuation of a Codex mirror derives a Maintenance-owned child;
  it never writes the continuation back to Codex.

## Acceptance breakpoints

The persistent run status log exposes the following focused checkpoints:

1. `projection.materialize` / `diag:projection-structure-verified`
2. `runtime.wal.durable` / `diag:append-intent-durable`
3. `runtime.canonical.committed` / `diag:canonical-append-committed`
4. `session.derivation.create` /
   `diag:codex-mirror-derived-without-source-write`
5. `session.append.commit` / `diag:durable-maintenance-receipt-written`

Only a failed checkpoint should be subdivided during live diagnosis.
