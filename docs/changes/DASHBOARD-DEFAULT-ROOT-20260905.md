# Discover the bundled Dashboard on normal Engine startup

Date: 2026-09-05. Baseline: `4b499271e9b8bc09de09f0dab3c5321d25f0104c`
(Engine 0.1.14; Maintenance entry 0.2.16).

The running Engine answered authenticated `/v1/health` with 200, but
authenticated `/dashboard/` with 404. Its process command used `serve` without
`--dashboard-root`. The Dashboard build existed at `apps/dashboard/dist`.
The CLI previously installed static serving only when that optional flag was
provided, so an otherwise healthy Engine could issue a Dashboard link whose
page was not served.

The CLI now finds the Dashboard relative to its own installed module:

- Workspace build: `apps/engine/{src,dist}` beside `apps/dashboard/dist`.
- Portable archive: `engine/*.mjs` beside `dashboard/`.
- An explicit `--dashboard-root` takes precedence and must contain `index.html`.
- A headless installation may omit the Dashboard and continues to start.

Discovery does not search the current working directory. Existing static file
boundaries, API authentication, and UI session claim/exchange remain in place.
No data format, runtime identity, adapter, deletion, or projection rule changes.

## Verification

- Seven focused test files passed: 20 tests covering default discovery, static
  files, UI sessions, projection identity/deletion, Engine proxy, and the recent
  official RC1 empty-session lifecycle fix.
- Engine typecheck and TypeScript build passed.
- A built CLI process was started with a marked temporary state root, zero
  registered real instances, an unrelated working directory, and no Dashboard
  flag. The current built Dashboard index and application script returned 200;
  authenticated health returned 200; unauthenticated Canonical API returned 401.
  The synthetic process and its marked fixture were removed after verification.

## Integration status

This patch is isolated on `codex/maintenance-dashboard-audit-20260905`, based on
the existing RC1 identity and empty-session fixes. Those fixes remain intact.
The main Maintenance checkout, Launcher worktree, runtime configuration, installed
plugin, and real session state were not changed or restarted by this patch.

At inspection time one real projection run was active. The running Engine still
uses the prior build; this source patch has not repaired that live process yet.
Activate the candidate in the normal release flow after a controlled runtime
stop and pending-write drain, then check the plugin's actual Dashboard entry.
No live browser acceptance is claimed. No package version was bumped for this
unreleased candidate.
