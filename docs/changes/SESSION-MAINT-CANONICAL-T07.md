# T07 — Public DSH Session Adapter SDK

## Scope

This task publishes the versioned interface and authoring documentation that
third-party developers use to add DSH codecs and Runtime Bridges. It does not
load untrusted packages or start child processes; Adapter Host isolation and
selection are T08.

## Changes

- Added `@linmu/dsh-session-adapter-sdk` with:
  - `defineAdapterManifest` and explicit interface-major negotiation;
  - `defineDshSessionAdapter` for probe, materialize, normalizeAppend, inspect,
    verify, and resolveReference;
  - `defineDshRuntimeBridge` for attach, drain, and detach;
  - `runAdapterCoreSmoke` for one bounded conformance path.
- Re-exported the DTO types an Adapter author needs, so the minimal third-party
  package depends on the SDK only.
- Core Smoke verifies manifest/probe identity, one-session materialization,
  inspection and digest verification, append operation identity, stable
  reference identity, Runtime Bridge identity, zero pending drain, and detach.
- `adapterApiVersion` is negotiated strictly before Adapter code is accepted;
  unsupported majors return `ADAPTER_API_UNSUPPORTED` with the accepted major.
- An experimental Adapter deliberately outside its declared DSH semver range
  passes Core Smoke when capability probing succeeds.
- Added author documentation for architecture, contracts, capabilities, version
  negotiation, authoring, testing, publishing, compatibility evidence, and a
  minimal example.
- Documented the hard trust boundary: Adapters receive DTOs, a projection root,
  and controlled bridge endpoints; they never access the Maintenance database.

## Focused verification

Commands:

    pnpm exec vitest run packages/session-adapter-sdk/test/conformance.test.ts
    pnpm --filter @linmu/dsh-session-adapter-sdk typecheck

Results:

- 1 test file and 3 tests passed.
- The SDK package typecheck passed.
- Experimental operation outside the declared DSH range passed behavioral Core
  Smoke.
- Adapter API major 2 produced the expected explicit failure report.
- The minimal example package has exactly one dependency: the public SDK.

## Breakpoint policy

Only manifest negotiation and the bounded one-session Core Smoke were run. The
Smoke checks the exact identities crossing each boundary; version matrices and
process crashes are deferred to Adapter Host and concrete Adapter tasks.

## Safety

- Tests use fake DTO-only adapters, in-memory projection readers/writers, and no
  filesystem or database access.
- Documentation explicitly forbids Maintenance database, Codex home, and user
  session access from Adapter packages.
- No package was installed into a live DSH instance or Launcher Profile.
