# M05 — Retained Alpha2 Projection Lifecycle

## Outcome

Alpha2 runs now reuse the format-family projection cache instead of rebuilding
or deleting the verified baseline for every run. The retained cache remains a
rebuildable derivative of Maintenance; it never becomes a second authority.

## Runtime layout

- The retained cache is the read-only base projection for a compatible Alpha2
  format family and projection configuration.
- Each run receives a sparse writable overlay, an isolated WAL, recovery state
  and runtime persistence directory.
- Reads prefer the overlay and fall back to the base; DSH writes never mutate
  the base while the run is active.
- The run catalog is copied and rebound without rewriting the retained cache.

This separation preserves Codex-derived branching. A first DSH continuation
can repoint the run-local native session to its derived Maintenance session
without overwriting the cached projection of the original read-only Codex
session.

## Shutdown and recovery order

1. Stop accepting new appends and drain the runtime.
2. Replay pending WAL records until Maintenance returns durable receipts.
3. Verify the layered projection and save the close Checkpoint.
4. Detach the runtime.
5. Apply the Canonical Change Journal to the retained cache.
6. Remove only the run-local overlay and release the writer lease.

If any step before cache refresh fails, the overlay and WAL remain available
for recovery. Recovery replays a projection-applied WAL before refreshing the
base cache, so an unconfirmed append cannot be lost behind a newer cache
Revision.

## Diagnostics and schema

- Added the terminal `projection.cache-retained` status span.
- The span contains only cache Revision and rewrite/removal counts.
- Schema v16 admits the new stage while preserving all existing status rows.
- The dashboard labels the new terminal breakpoint.

## Focused verification

- A clean second run performs no Canonical body load, no selected body load,
  and no retained session or catalog rewrite.
- Runtime appends change only the sparse overlay until their durable Canonical
  change is applied to the retained cache at close.
- Crash recovery replays a pending projection-applied WAL before cache refresh
  and removes the overlay only after success.
- Alpha2 Adapter, Projection Lifecycle, Engine stream/Broker/provider,
  integration and schema-migration tests pass.
- `pnpm typecheck` passes for all 25 workspace packages.

All verification used synthetic temporary stores. No real Codex Home, DSH
Home, Launcher profile or Generation was read for mutation or written.
