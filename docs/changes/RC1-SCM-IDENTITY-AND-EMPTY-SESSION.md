# RC1: exact SCM identity, canonical delete, readable blank sessions

Date: 2026-09-05. Engine 0.1.14; DSH entry 0.2.16; paired SCM 0.3.1.

## Captured failure and exact boundaries

A read-only authenticated `annotationCore/readPending` request for projected
empty session `dsh-maintenance_bHNfYjZhOWM0NTNhZDZjMzdmYzJjZWFkYmVl`
returned `session/not-found`. Its catalog eventCount is 0; no runtime artifact
exists. A nonempty session's identical request returned revision 0, pending null.
The annotation service itself was available; its generic unavailable message
hid the underlying session lookup failure.

RC1 official `uiWorkspace.connectWorkspace` may reuse an existing blank session.
RC1 `PersistenceCoordinator.create` only registers lazy metadata. Maintenance
marked a zero-event hydration complete without persisting its header. Thus the
reused session bypassed lazy borrow and failed at the native persistence lookup.

The fix stays in the Maintenance runtime binding, using RC1's public
prepare/enter/announce/ensureMaterialized lifecycle and paired detach. In
particular, no `seed: []` is passed, because RC1 would then append `session/end-seed`.
The real RC1 component fixture proves read failure before, successful borrow
after, and exactly zero stored/observed events. Failure never marks it hydrated.

## Identity and deletion

SCM supplies only the native ID selected by the official row handler. The Host
pins the projection run from launch attestation; the browser cannot choose a
different run, logical ID or instance for deletion.

Engine exposes read-only `GET /v1/projection-runs/:run/sessions/:native/identity`.
It joins exact run/native mappings to Canonical identity, restricted to active
run states. No title matching or fallback to legacy platform bindings occurs.

`POST /dsh-session-maintenance/api {operation:"delete-session",sessionId}` calls
`DELETE /v1/projection-runs/:run/sessions/:native`. Engine resolves the exact
current mapping and calls the existing canonical delete function synchronously,
without an await between resolution and mutation. It retains its checkpoint,
tombstone, pending-write and recovery policies. The entry validates the returned
logical ID and deletion state; SCM hides the native row only after this receipt.
No popup/dashboard redirect, physical purge, or Codex write adapter is involved.

## Key checks and status entrances

1. Same-title identity: selected native ID -> attested run -> distinct logical ID.
   Closed/missing mapping refuses without delete; failed identity never guesses.
2. Delete: use a disposable session, no popup; existing Engine status record
   `run.shutdown-recovery` carries native ID and `diag:session-delete:<logicalId>:<state>`.
   Pending-write and post-receipt UI refresh failures must remain distinguishable.
3. Blank: Launcher log `runtime.empty-session.materialized` includes native ID
   and eventCount=0. Then readPending succeeds and the user can send once.

Only subdivide a failed boundary. No real user session was deleted by automated
tests; no model request was sent. User browser acceptance is pending.

## Unchanged

- Codex files, database and running process are not modified.
- Canonical event bodies, IDs, workspace/project ownership and old versions stay
  unchanged. No database migration or bulk backup is needed for these changes.
- Existing adapter families, persisted cache policy, model settings and official
  compaction configuration stay unchanged. No Launcher rebuild or Generation.
- Development-only scope/timeout dependencies enable a real RC1 lifecycle test;
  they are not shipped as private host-core dependencies in the plugin bundle.

Deploy after normal RC1 stop; update both entry and Engine before restarting RC1.

## Local deployment verification

- User stopped RC1 normally. Its shutdown/recovery finished successfully; the
  read-only database check found no active projection run and zero pending run
  operations. Existing 339-session cache was retained, not rebuilt.
- Rebuilt Engine 0.1.14 and installed Maintenance 0.2.16 + SCM 0.3.1 into the
  Launcher's `0.1.2-rc.1/profiles/web`. Exactly these two dependency entries
  changed; the remaining manifest including profile configuration is identical.
- Installed entry/client hashes match the built sources. New Engine health is
  ready, and its identity endpoint rejects the closed run with SESSION_NOT_MAPPED.
- 48 Maintenance/Engine checks and 23 SCM checks pass; typechecks/builds pass.
  The empty-session fixture uses official RC1 SessionStore/PersistenceCoordinator,
  and the delete HTTP fixture proves parent/source preservation and idempotence.
- User acceptance is still pending. No browser automation or actual conversation
  send/delete was performed. RC1 remains stopped for the user's next start.
- Small rollback copies contain only Engine build files and three Profile
  manifest/lock/config files; no Canonical database snapshot was created.
- Local artifact SHA-256:
  - Maintenance: `43b7fc8fbe8f914be095cc9e61c7592e9060363a7f904984dfd6b39ec8c41a25`
  - SCM: `c3d27c866f506d852b7ee47b9e26fe982e5b3a4e830efba2638e99083e71628f`
