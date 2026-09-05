# Launcher Hook and Maintenance Provider

Launcher owns the generic external lifecycle Hook. Maintenance owns the Provider in this repository and its Runtime Broker operations. A configuration file can select an existing Hook; it cannot add missing host code. Keep the Launcher patch/version and its acceptance evidence alongside release records, without embedding session SQL, Codex scanning or retention policy into the host.

## Protocol and invocation

The current Engine CLI accepts one schema-v1 JSON request on stdin and returns JSON on stdout:

```powershell
node .\engine\dsh-session-maint.mjs --state-root "<维护状态目录>" external-lifecycle
```

This is a host-driven command, not a manual import command. The host must send the appropriate request and retain the returned handle. The strict request fields are defined in [Provider source](../../apps/engine/src/external-lifecycle-provider.ts):

| Phase | Request fields in addition to `schemaVersion: 1` and `phase` | Responsibility |
| --- | --- | --- |
| `prepare` | `instanceId`, `profileId`, `runtimeVersion`, `web` | Prepare Canonical runtime projection and return launch configuration/handle |
| `beforeStop` | `handle`, `runtimeUrl` (nullable) | Request graceful runtime drain before the host stops its child |
| `afterExit` | `handle`, `exitCode` (nullable), `requestedStop`, `forced` | Finalize or recover after child exit |
| `abort` | `handle`, `reason: "spawn-failed"` | Recover preparation when child launch failed |

The current Provider accepts `0.1.2-alpha.2` and `0.1.2-rc.1`; an RC2 Adapter elsewhere in the repository does not extend that allowlist. Protocol versions and required persistence capabilities must match; config alone cannot override these conditions.

`prepare` consumes existing Canonical state. The current composition additionally synchronizes Codex catalog titles before preparation, but does not fully import Codex message bodies. Import progress, projection preparation and runtime append acknowledgements are separate facts. During a run, the DSH plugin communicates directly with Engine.

## Host integration verification

Use marked synthetic state and projection directories. Verify Hook disabled, normal start/stop, prepare timeout, child exit, spawn failure, repeated notifications, incompatible protocol and recovery followed by restart. Preserve the handle and pending-write evidence until the Engine has acknowledged finalization. Do not infer that a timeout cancelled Engine work or that an exited child guarantees a closed run.

Provider timeouts and startup behavior are implementation details of the matched build; inspect source when changing host deadlines. The current Provider allows longer preparation/finalization than ordinary Broker requests. Release records must include the Launcher revision and local patch state, not just its profile JSON.
