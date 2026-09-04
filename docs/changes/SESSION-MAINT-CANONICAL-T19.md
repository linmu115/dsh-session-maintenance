# T19 — Replace Native Mirror with canonical projection

Date: 2026-09-01

## Outcome

Session Maintenance now selects its active SQLite database through `config.yaml`, builds a
fully validated canonical candidate beside the preserved v6 source, and switches the pointer
only after explicit confirmation and integrity checks. Production runtime composition uses
`CanonicalSessionEngine` and creates `ProjectionLifecycle` instances for the built-in Alpha2
or RC2 adapter.

## DSH breaking-change response

- DSH homes and Launcher profiles no longer own durable session content. The active DSH version
  receives a temporary native projection generated from Maintenance canonical sessions.
- Alpha2 and RC2 native formats remain inside their adapters. Engine composition selects the
  registered adapter and supplies the same canonical source and append engine.
- A first DSH write to a Codex-owned mirror is handled by canonical derivation instead of a
  writable Codex native mirror. Codex content remains Codex-authoritative; the DSH continuation
  becomes a Maintenance-owned child.
- Stable logical workspaces replace per-instance workspace ownership. Legacy
  `binding_workspaces` rows are converted once into `logical_workspaces` and
  `workspace_memberships`.
- Legacy normalized heads are resolved from `platform_refs`, converted to canonical events, and
  retain DSH raw event envelopes needed for faithful Alpha2/RC2 materialization.

## Removed runtime

- Deleted `packages/native-mirror-engine` and its integration test.
- Removed `/v1/mirrors` routes and local-client methods.
- Removed Native Mirror write gating and post-transaction bookkeeping from Engine.
- Marked the 2026-08-27 Native Mirror plan as superseded.
- Added a contract test that rejects future production imports, HTTP routes, or service usage.

The v5/v6 Native Mirror schema and deprecated contract records remain readable only as migration
history. They are not loaded by the production runtime.

## Migration safety and observed activation

- Read-only preview: 637 sessions; 409 Codex, 228 DSH; zero review-required or unclassified.
- Corrected candidate: schema 8, 637 sessions, 423,100 events, 131 workspaces, 637 memberships.
- Candidate SHA-256: `5fb555ff60cfa5d9fbe89af34fb8c632f4772d0509d7227b4bbbb6d5afc587c9`.
- Original source SHA-256 remains
  `e0b42970efb7aa29312cb471e05c9fa2f3cc40fab2b3261203da3c7de1ff0bc4`.
- Rollback: point `databaseFile` back to `metadata.sqlite`; the source and read-only v6 archive
  remain intact.

## Focused validation

```text
pnpm exec vitest run packages/session-store/test/canonical-engine-store.test.ts tests/integration/canonical-migration-activation.test.ts tests/contract/no-native-mirror-runtime.test.ts
```

The activation test proves copy-and-convert semantics, source hash preservation, event/workspace
counts, and a separate config-pointer switch. The contract test proves that the obsolete runtime
cannot re-enter production code. The canonical store test proves the foreign-key-safe order for
creating a Codex mirror and atomically deriving its first DSH continuation.
