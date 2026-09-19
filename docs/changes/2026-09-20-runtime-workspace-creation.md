# Runtime-created Maintenance workspaces

## Problem and resulting behavior

A selected-workspace DSH instance with unassigned sessions disabled could create a local project, but the Broker registered its new session with `workspaceId: null`. The first turn then failed at the canonical scope guard and surfaced a generic durable-receipt error.

New session registration now resolves an explicit workspace, an instance/project binding, or a unique existing project membership. When no workspace exists, Maintenance creates one and adds just its ID to the originating run and the instance's saved policy. Existing excluded workspaces and ambiguous project memberships remain explicit errors. Native hosts that expose only cwd create the workspace at first session registration.

Schema 28 persists workspace bindings and registration intents. Workspace creation, the saved-policy addition, the current-run addition, and the intent are transactional. Native session registration follows as an idempotent stage; a failed stage can leave the requested workspace registered, but cannot report successful session creation before its durable registration finishes. Other pending policy edits and other runs remain unchanged. Cache scope revision remains fixed through shutdown, independently of the effective selection.

The append boundary preserves `SESSION_NOT_SYNCED` and its message. Retention readers recognize schema 28. Old databases migrate forward; running schema-27 engines must not open a migrated database.

## Verification

Focused tests cover RC1 close/restart and registration interruption, RC2 v3 first-turn commits and replay, restricted scope with unassigned disabled, repeated creation, rollback, explicit/ambiguous existing membership, later deselection, sibling-run and cross-instance isolation, pending manual edits, and domain-error preservation.

- Passed 78 targeted tests across 13 test files, including schema migration and retention compatibility.
- Passed workspace type checking (`pnpm -r --if-present typecheck`) and the complete build (`pnpm build`). The engine build also passed after the final HTTP error handling change.
- Passed `git diff --check`.

## Task history

The user rejected enabling unassigned sessions as the product solution and confirmed automatic Maintenance creation with automatic enrollment of the creating instance. Investigation found the hard-coded null workspace and the frozen run scope. The first integration run exposed an additional cache-identity failure on close; separating the cache's initial revision from the effective run selection fixed the close/restart path. This account summarizes the current task; native transcript source indexing has not been added.

Deployment and recovery of the already-failed live session are separate from the synthetic tests; this change does not silently rewrite old WAL records or real DSH/Codex homes.
