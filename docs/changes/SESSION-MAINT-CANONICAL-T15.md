# T15 — Canonical workspace and lineage dashboard

## Outcome

- Added authenticated, read-only Dashboard APIs for the canonical workspace tree and canonical session detail.
- The APIs read only Maintenance-owned stable tables. They do not open a Codex Home, DSH Home, Launcher profile or Obsidian Vault.
- Replaced the session directory's legacy native workspace summaries with `logical_workspaces` and `workspace_memberships`, including nested folders, pin order and an unclassified bucket.
- Replaced historical version Markdown rendering with a static `CanonicalEventV1` transcript.
- Unknown events are held out with a diagnostic link. Historical HTML, tool calls and opaque payloads are rendered only as React text or escaped JSON and are never executed.
- Added parent and derived-session navigation in both directions. Equal titles remain distinguishable through logical IDs and source labels: Codex sync, Maintenance native and Codex derived.
- Added stable accessible names and `data-testid` markers at workspace, session, event and lineage breakpoints.

## Focused breakpoints

- Canonical directory: nested workspaces, membership ordering and unclassified sessions.
- Static transcript: escaped historical HTML and `opaque-unknown` hold-out behavior.
- Canonical API: session content remains readable while no DSH process is running.
- Lineage: parent-to-child and child-to-parent relations resolve to full logical session records.

## Verification

- `pnpm exec vitest run apps/dashboard/test/canonical-workspace-model.test.ts apps/engine/test/canonical-dashboard-api.test.ts`
- Typechecks for contracts, local API client, Engine and Dashboard.
- Dashboard production build.

All verification used temporary synthetic state. No real platform home or user vault was written.
