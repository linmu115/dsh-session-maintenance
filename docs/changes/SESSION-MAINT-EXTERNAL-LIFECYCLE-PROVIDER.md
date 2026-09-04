# Engine 0.1.4: external runtime lifecycle provider

## Boundary

Launcher remains a thin, provider-neutral process owner. It invokes the
Maintenance Engine CLI once per lifecycle phase and never learns Runtime Broker
routes, Bearer capabilities, Adapter selection, projection layout, DSH shutdown
details, or recovery policy.

The provider command is:

```text
dsh-session-maint --state-root <maintenance-state-root> external-lifecycle
```

Each invocation reads one schema-v1 JSON request from standard input and writes
one exact schema-v1 success response to standard output. Failures write a
diagnostic to standard error and exit nonzero; they never emit a parseable error
response on standard output.

This capability belongs to `@linmu/dsh-session-maintenance-engine` 0.1.4. The
DSH plugin remains 0.2.0 and its package artifact is unchanged.

## Exact Launcher contract

`prepare` receives top-level `instanceId`, `profileId`, `runtimeVersion`, and
`web`. Maintenance owns the current defaults (`main`, automatic Adapter, all
projects); Launcher supplies no provider configuration.

The provider only enables `web: true` with runtime version exactly
`0.1.2-alpha.2`. Non-Web, RC2, and any unknown/newer version return:

```json
{ "schemaVersion": 1, "enabled": false, "handle": null, "launch": null }
```

The compatibility gate executes before Engine discovery, Broker prepare, or
patch creation, so an Alpha2 patch can never be injected into RC2.

An enabled response contains only `schemaVersion`, `enabled`, opaque `handle`,
and `launch.args/env`. It redirects Alpha2 `session-persistence-jsonl` to the
Broker-owned temporary projection and passes the run metadata required by the
Maintenance plugin. The Engine token is neither returned nor stored in the
handle file.

`beforeStop` receives only `handle` and `runtimeUrl`. The provider validates a
loopback URL and calls the run-scoped DSH shutdown endpoint. HTTP 202 records a
durable `shutdownAcceptedAt` marker and returns `action: "wait"`; missing or
failed shutdown returns `action: "force"`.

`afterExit` returns only `{ "schemaVersion": 1, "ok": true }`. Normal Broker
close is authorized only when all three conditions hold:

- Launcher reports `requestedStop: true`;
- Launcher reports `forced: false`;
- the handle already records a successful graceful-shutdown acknowledgement.

A spontaneous exit, a forced exit, or a requested stop without accepted
shutdown goes directly to Runtime Broker recovery. If an authorized normal
close still lacks the plugin runtime-drained acknowledgement, the provider
falls back to recovery. The final internal receipt is persisted for idempotent
retries but is not exposed through the generic Launcher protocol.

`abort` accepts only `reason: "spawn-failed"`, selects recovery, and returns the
same minimal acknowledgement.

## Safety and verification

Handle paths use a restricted alphabet and are atomically replaced under the
Maintenance state root. Failed recovery preserves the handle as
`recovery-required`; it does not delete evidence or touch a real DSH Home.

Focused breakpoints cover:

- exact response shapes accepted by Launcher's `deny_unknown_fields` parser;
- compatibility rejection before any Engine or filesystem side effect;
- Alpha2 patch and launch metadata generation;
- graceful shutdown acceptance before normal close;
- direct recovery for spontaneous/forced/unacknowledged exits;
- abort recovery and idempotent final acknowledgement;
- malformed or oversized stdin producing empty stdout and nonzero exit.
