# Engine 0.1.5: large-projection lifecycle recovery

## Observed failure

An Alpha2 launch with 486 canonical sessions and about 1.1 million events took
roughly 43 seconds to materialize. The external lifecycle provider used the
ordinary 15-second Broker RPC timeout for `prepare`, so it disconnected while
the Engine continued the successful materialization. The completed projection
remained in `preparing` and held the `main` writer lease. Later launches failed
at the `run.lease` breakpoint with `LEASE_HELD`.

The fallback recovery path then treated the never-attached projection like a
running projection. That performed a redundant full inspection and prevented
the stale lease from being released when the close verification failed.

The first live Launcher retry exposed a separate Alpha2 command grammar break.
Lifecycle arguments were appended after Web App arguments, producing
`dsh --profile web --host ... --patch ...`. Alpha2 forwards every token after
the first unknown launcher option (`--host`) to the Web App, so the Web App
rejected the later launcher-owned `--patch` with `unknown option '--patch'`.

## Fix

- `prepare` now has a dedicated 240-second Broker timeout. Ordinary lifecycle
  RPCs retain their 15-second timeout.
- A materialized projection that never reached `runtime.persistence.attach`
  is discarded through a dedicated pre-attach recovery path. It uses the
  already verified manifest, records a close checkpoint, removes only the
  temporary projection, and releases the writer lease without replaying or
  inspecting native runtime data.
- The same path works after an Engine restart while the persisted run is still
  `preparing`; no in-memory prepared handle is required.
- Status events identify successful and failed pre-attach disposal with
  `diag:prepared-projection-discarded` and
  `diag:prepared-projection-discard-failed`.
- The generic lifecycle response now returns `--patch` in `launcherArgs` and
  leaves profile-app `args` empty. Updated Launchers place `launcherArgs`
  before `--profile`, while the original `args` field retains its append-only
  behavior for existing providers.

Canonical sessions, Codex authority, project/workspace mappings, and real DSH
Homes are not modified by this recovery path.

## Focused verification

- Provider prepare/abort and lifecycle protocol tests.
- Runtime Broker test proving launch abort calls pre-attach disposal and never
  enters full runtime-tail recovery.
- Projection Lifecycle restart test proving a disk-backed prepared projection
  is checkpointed, removed, and marked `recovered` without runtime attach,
  drain, detach, or a second adapter inspection.
