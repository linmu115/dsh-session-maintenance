# Session Maintenance Phase 2 P17-P22 Completion Plan

**Goal:** Complete the independent operation API, DSH-aligned Dashboard, version workbench, recovery UI, version-locked DSH entry plugin, and isolated packaging gate without touching a formal Codex/DSH home.

**Execution rule:** Implement CLI/Engine/API first and make every UI/plugin action consume that same typed surface. Reuse P14-P16 transactions and P23-P28 continuation contracts; do not create parallel state machines. Run one focused contract/integration gate per P and reserve whole-workspace validation for P20 and P22.

## P17 — Typed operation surface

- Add bounded/lazy session, version, transaction, checkpoint, diagnostics and settings DTOs.
- Extend repository/Engine and expose apply/restore/checkpoint operations as persisted jobs.
- Complete `MaintenanceClient`, cursor/SSE resume and request-field/path rejection.
- Focused gate: client/server parity plus write-job idempotency.

## P18 — Dashboard baseline

- Resolve the management-kit redistribution gate; if no explicit license is present, record the decision and independently implement the approved `--dsm-*` visual contract.
- Add React/Vite standalone Dashboard and shared session UI package.
- Implement sticky shell, overview, paged session list, offline/loading/empty states, and sanitized Markdown.
- Focused gate: first render requests summaries only and production bundle contains no token/path/Maintenance runtime.

## P19 — Version workbench

- Add one reusable graph layout/canvas for linear/divergent/two-parent histories.
- Add node-linked version content, three-way diff, plan preview and Checkpoint editor/routes.
- Keep graph/body/diff lazy and preserve review plans as read-only.
- Focused gate: deterministic lanes, divergence display, plan risk controls and checkpoint preview.

## P20 — Recovery, diagnostics and settings

- Add transaction summaries/detail timeline, scoped recovery panel, adapter report and ID-only settings form.
- Wire Dashboard pages to P17 DTOs; no new recovery business rules in UI.
- Batch B gate: affected API/UI tests, Phase 1 regression, full typecheck/build and bundle boundary scan.

## P21 — Version-locked DSH entry plugin

- Build thin `dsh-session-maintenance` plugin with exact `0.1.1-rc.2` host/client contract fingerprint.
- Provide restricted Engine proxy, session actions, optional sidebar entry and parameter/action panel with only short feedback.
- Future native-mirror controls stay disabled; continuation action may use the already completed P23-P28 API.
- Focused gate: supported/drifted fixture, path rejection, offline action, unload cleanup and tgz inspection.

## P22 — Package and isolated acceptance

- Add reproducible Engine+Dashboard/plugin packaging, manifest hashes, clean-clone/bootstrap and boundary scripts.
- Install only into a marked temporary rc.2 profile and run loader/action/safe-fast-forward/divergence/recovery/uninstall checks.
- Generate formal-profile replacement preview, but do not alter the user profile or uninstall an existing plugin without a separate approval.
- Final gate: Phase 1/2 focused suites, clean bootstrap/build/package, portability scan and acceptance report.

## Commit and report map

- P17: `docs/changes/DSH-SESSION-MAINTENANCE-20260827-029.md`
- P18: `...-030.md`
- P19: `...-031.md`
- P20: `...-032.md`
- P21: `...-033.md`
- P22: `...-034.md`

Each P is one independent commit. Stop after P22; do not implement stage-four native Codex writes.
