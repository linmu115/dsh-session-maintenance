# Runtime Broker projection preflight and native import seam

## Diagnosed runtime break

Launcher currently passes only endpoint and adapter metadata. It does not call
a public Runtime Broker `prepareRun` / `closeRun` protocol and therefore cannot
hand a real `runId` to the DSH plugin. Engine contains a tested in-process
P1/P2/P3 lifecycle, but no client-neutral broker API or cross-process runtime
bridge. The plugin parses and discards the metadata and never attaches
`sessionPersistence`.

Maintenance must not be activated by Launcher. The Runtime Broker is an
independent service; Launcher is only its first client. A plugin or CLI must be
able to bootstrap through the same prepare, attach, append and close protocol.

Alpha2's official JSONL backend supports a configured root only at provider
startup. Its public persistence service has no delete operation, but Alpha2
does expose the required durable event seam: `session/event` is a post-commit
firehose and `session/flush` is an awaited durability checkpoint. The plugin
must forward the former into Engine WAL and drain the per-session pending queue
on the latter. It must not monkey-patch `sessionPersistence.append`.

For native DSH grouping, the canonical project root is projected to
`SessionHeader.cwd`. Canonical workspace membership remains an independent
Maintenance relation. Reverse ingest must never derive or overwrite that
workspace relation from the native `cwd` value.

## Safe additions

- A reusable, version-probed `DshNativeImportSource` and
  `DshNativeImportService` can import a normalized Alpha2 session as an initial
  `maintenance-native` canonical session without fabricating a projection run
  or projection receipt. Capability probing now rejects a reader that treats
  native `cwd` as canonical workspace authority. No real database or DSH Home
  is accessed by tests.
- `projectionRuntimePreflight()` exposes P1, P2, P3, append, close and grouping
  checkpoints with the same status-log stage names and stable diagnostic refs.
  It is independent of the calling client. `projectionLaunchPreflight` remains
  as a deprecated source-compatible alias.
- P2/grouping require project-root-to-`cwd` mapping; grouping also requires
  independent Maintenance workspace authority.

## Remaining implementation seam

The safe live sequence is: a Runtime Broker client requests `prepareRun`;
Engine creates and materializes a preparing run; the client receives its real
`runId` and an opaque per-run persistence-root ID; the DSH plugin imports the
projection through official persistence calls and acknowledges attach; durable
native appends are forwarded with WAL semantics; any authorized client calls
`closeRun`; cleanup removes the entire temporary root. Launcher, plugin and CLI
all use this same protocol.

The public event seam is available, but the forwarding backend is not yet
wired in this commit. Until it is, preflight returns the exact blocked
checkpoint and diagnostic log reference without creating a fake
`projection_runs` row.

## Focused verification

- Native import capability is probed before reading; incompatible Alpha2
  formats perform no read or canonical commit.
- A reader that maps native `cwd` back onto canonical workspace membership is
  rejected before reading.
- A compatible synthetic source preserves its native ID and Maintenance
  workspace membership while calling the dedicated import primitive.
- Metadata-only clients fail at the exact P1/P2/P3/append/close/grouping
  checkpoints; complete broker evidence passes every checkpoint.
