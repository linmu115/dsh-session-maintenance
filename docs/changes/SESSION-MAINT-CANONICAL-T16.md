# T16 — Maintenance operations, deletion recovery and run center

## Outcome

- Added canonical session management for title, tags, logical workspace, display order, pin and archive state.
- Deleting a logical workspace now moves its sessions and child workspaces to the unclassified root; it never deletes session content.
- Added local-first logical session deletion with a deletion-preflight Checkpoint, durable tombstone, 30-day retention marker and recently-deleted recovery view.
- Codex mirrors are only tombstoned in Maintenance. The delete path performs no Codex write.
- Active projections now expose a session-level drain-and-hide lifecycle operation. Accepted writes must drain before the runtime overlay removes the native session.
- If pending operations remain, the session enters `pending-delete`, projection mode changes to `recovery-only`, recovery material stays intact and P8 records `DELETE_PENDING_WRITES`. A later retry creates the Checkpoint and tombstone only after pending writes are committed.
- Restore clears either a completed tombstone or a pending-delete marker, restores logical workspace membership and re-enables the correct projection mode.
- Added WebUI pages for recently deleted sessions, P1-P8 run status, leases/pending counts and Adapter registrations.
- Adapter selection is capability-probed in the isolated host. Versions outside the tested list can still be selected as experimental; semver is not an installation lock.

## Focused breakpoints

- WebUI mutation model: stable logical fields only, no native workspace/session IDs.
- API main chain: update -> pending-delete -> pending commit -> Checkpoint -> tombstone -> projection hidden -> restore.
- Projection lifecycle: session-level drain completes before runtime hide and repository mode update.
- P8 status entry: started plus succeeded, or failed with a bounded pending-write error code.
- Codex fixture tree hash remains unchanged across the complete operation chain.

## Verification

- `pnpm exec vitest run apps/dashboard/test/maintenance-operations.test.ts apps/engine/test/maintenance-operations-api.test.ts tests/integration/delete-restore-projection.test.ts`
- Typechecks for contracts, local API client, Engine, Dashboard, projection lifecycle, Alpha2 Adapter and DSH plugin.
- Production builds for Dashboard, Alpha2 Adapter and DSH plugin.

All tests used temporary synthetic homes and projection directories. No real Codex Home, DSH Home, Launcher profile or Obsidian Vault was written.
