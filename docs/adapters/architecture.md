# Architecture and trust boundary

Maintenance owns canonical sessions. An Adapter is a replaceable codec for one
DSH storage/runtime shape. It receives typed DTOs, a temporary projection root,
and a controlled Runtime Bridge endpoint.

An Adapter must not:

- open, query, copy, migrate, or mutate the Maintenance SQLite database;
- read a Codex home;
- choose logical session identity;
- create global deletion tombstones;
- treat a native DSH session or workspace ID as canonical identity.

Core owns leases, operation idempotency, canonical commits, tombstones,
checkpoints, status logs, and Adapter selection. The Adapter owns probe,
materialization, native-append normalization, inspection, digest verification,
and stable-reference resolution inside its temporary projection.

## Runtime and host boundary

The Engine owns Canonical orchestration and storage; the Dashboard consumes its
API. The DSH plugin attaches the official runtime persistence seam, loads
sessions on demand and sends normalized appends directly to Engine. Launcher
is not in the per-message path.

Codex reading belongs to the Codex read adapter and import flow. Preparing a
DSH projection consumes already imported Canonical state. Current composition
also synchronizes Codex catalog titles before projection preparation; that is
not a full source-content import.

The Maintenance external lifecycle Provider stays in this repository. The
generic prepare/beforeStop/afterExit/abort Hook belongs to Launcher and only
manages host timing, protocol, deadlines and failure cleanup. Configuration
cannot provide a Hook absent from the host implementation. See the
[Hook onboarding guide](../deployment/launcher-hook.md).

Current [support evidence](compatibility-matrix.md) distinguishes Alpha2, RC1
and RC2 codec implementations from validated deployment combinations. The old
RC2 Core Gateway transaction channel is not the current RC1 Canonical append
path. Do not reintroduce EAC, dsh-codex-session-sync or Native Mirror runtime.
