# DSH 0.1.1-rc.2 Core Extension Design

## Status and scope

This specification implements the approved phase-two route A: maintain a version-locked DSH Core extension so Maintenance can finish P15 and P16 without pretending the public rc.2 write surface is reversible.

It covers only cold DSH session creation, strict-prefix append, title append, archive state, verification, and exact restore. It does not add deletion, in-place history reset, Codex writes, Dashboard work, EAC compatibility, shell lifecycle control, or formal-profile installation.

All implementation and acceptance tests use synthetic, marked temporary profiles. Production code receives registered instance/session identities; callers never provide artifact paths.

## Chosen approach

Three approaches were considered:

1. Fork four official DSH packages. This provides strong typing but spreads one Maintenance interface across persistence, workspace, projection, and query packages and makes every DSH update a multi-package rebase.
2. Add one in-process, version-locked Core extension. This keeps the public DSH services for forward writes and concentrates the missing snapshot, inverse, cache invalidation, and reconciliation behavior behind one small interface. This is the chosen approach.
3. Edit a stopped profile out of process. This is simpler but cannot prove that in-memory coordinator and derived indexes agree, and it couples correctness to process management.

The chosen module is deliberately deep. Callers learn four operations while its implementation owns the exact rc.2 storage and runtime coordination details.

## Architecture

```text
TransactionExecutor
        |
        v
DshWriteAdapter  -- translates normalized sessions to locked DSH events
        |
        v
DshHostGateway   -- transaction token, plan hash, identity and payload limits
        |
        v
DshCoreExtension -- capture / apply / verify / restore
        |
        +-- official sessionPersistence create/append (forward authority)
        +-- workspaceRegistry attach/archive (forward metadata)
        +-- locked rc.2 inverse hooks (restore/unarchive)
        +-- projection-cache invalidate/restore
        +-- query-index reconcile from authoritative persistence
```

`DshCoreExtension` is the external seam. The production rc.2 host and the synthetic fixture host are the two adapters at its internal host seam.

The interface is:

```ts
interface DshCoreExtension {
  probe(): Promise<DshCoreProbe>;
  capture(request: DshCoreCaptureRequest): Promise<DshCoreSnapshot>;
  apply(request: DshCoreApplyRequest): Promise<DshCoreState>;
  restore(request: DshCoreRestoreRequest): Promise<DshCoreState>;
}
```

`capture` is non-mutating. `apply` and `restore` reject a live session, serialize by session ID inside DSH, reconcile derived state before returning, and return an observed state digest. The interface accepts DSH-native header/event DTOs, workspace IDs, and booleans; it accepts no path or shell field.

## Locked rc.2 contract

The extension supports only DSH `0.1.1-rc.2`, session format `v0`, workspace domain `v2`, projection-cache domain `v3`, and query SQLite schema `v8`.

The contract fingerprint includes package versions, npm integrity where captured, public method sets, domain/schema versions, and SHA-256 of the exact implementation files whose internal hooks are used. The initial source hashes are:

- session core `lib/index.js`: `c0bb646e5dc33ab770fc14531bc60ce6660a4ac07b47c0c180c909f51e9ffc8d`
- session persistence `lib/index.js`: `d08210e95ae22c7cb22a6208f0ebc02d38898f01aabf4f82924ee2bffcbc2cad`
- JSONL persistence `lib/index.js`: `8b6ebc4509a3e969ab3ad6e0dfb553ae4861e5b101831afed23e593d148d97f3`
- workspace `lib/index.js`: `d53e71d931937066ff20440afcff911ced09cefb8a0f3d024348b0e5248d4c74`
- projection cache `lib/index.js`: `4610b2c2405b0e059caf651a9c35babcee3badedb7225d4d242a7388b2f9b1d1`
- query SQLite `lib/index.js`: `d35c13881eeb9d393fa3a21acaafa6277692e77f90e579ea62a95d6ea0cf370a`

A missing field, extra method dependency, different source hash, patched package, unsupported compression, or storage schema drift yields `ADAPTER_INCOMPATIBLE` before capture or mutation. The extension never guesses compatibility from a version string alone.

## Mutation and restore rules

The session artifact is authoritative. Workspace membership/archive state is durable metadata. Projection and query data are derived but must be coherent before a successful response.

For every transaction, `capture` records:

- target absence or the exact physical session artifact and persistence revision;
- target workspace membership position;
- target archive state;
- target projection-cache row or confirmed absence;
- the contract fingerprint and target identity.

`apply` uses this fixed order:

1. Re-probe the locked contract and reject a live/busy session.
2. Re-check the captured persistence revision or absence.
3. Use official `sessionPersistence.create/append` for session events.
4. Attach a newly created session to the registered workspace when requested.
5. Apply archive state through the public forward operation or the locked inverse.
6. Delete the stale projection row.
7. Reconcile the query index from persistence and read the final state.

`restore` uses the authoritative-first order:

1. Re-probe and reject a live/busy session.
2. Atomically replace or remove the physical artifact from the captured snapshot.
3. Clear persistence coordinator state and prepared-read caches for the target ID.
4. Restore exact workspace membership and archive state.
5. Restore the projection row or its prior absence.
6. Reconcile the query index from restored persistence.
7. Read every domain and compare the resulting digest to the snapshot digest.

Any third state, incomplete snapshot, hash mismatch, failed reconciliation, or failed post-restore read returns an explicit failure; it never reports a successful rollback.

## DSH event translation

Platform format knowledge remains in `adapter-dsh-write`.

- User messages become identified `user/message` events with source `user`.
- Assistant messages become a balanced `turn/start`, `step/start`, identified `assistant/message`, `step/end`, `turn/end` bracket with imported provider/model provenance.
- A title change becomes a `session/title` event with user source and the exact referenced user-message sequence list.
- Attachments and tool imports are not forged as native DSH tool calls in phase two. A plan containing them is rejected with `WRITE_CAPABILITY_UNAVAILABLE` before capture.

Sequences are contiguous from the target durable cursor. Event IDs are derived deterministically from normalized event IDs and the plan hash, so preparing the same plan twice is byte-stable.

## Gateway and transaction integration

The gateway token is short-lived and bound to `{transactionId, planHash, instanceId, sessionId}`. Requests contain only `probe`, `capture`, `apply`, `verify`, or `restore`; unknown methods and path-shaped fields are rejected. The browser never receives this token.

`DshWriteAdapter.prepare` persists a canonical prepared descriptor inside the Engine transaction directory before backup. Recovery loads this descriptor to verify a possibly completed commit; it never reconstructs after-state from before-state fingerprints.

The adapter stores one canonical `DshCoreSnapshot` object through `TransactionBackupStore` and returns its content-addressed manifest. Restore resolves only the manifest entry named `dsh-core-snapshot`; it does not accept a path from the transaction database.

## P16 engine semantics

Only these safe plan shapes are executable:

- missing target: create target plus initial supported messages and optional title/archive;
- existing strict prefix: append supported messages and optional one-sided title/archive;
- metadata-only source change: title and/or archive;
- equal plan: no platform mutation.

Target-ahead, diverged, rewritten, identity conflict, metadata conflict, deletion, reset, and any unsupported event remain non-executable and preserve both heads.

`WriteService` delegates one immutable plan to `TransactionExecutor`. After `completed`, it observes the DSH target through `DshReadAdapter`, records the resulting immutable version, and atomically moves the target head, both bindings' `lastCommonVersionId`, and canonical ref. No ref moves occur for `restored`, `restore-failed`, `manual-review`, or stale transactions. Reapplying the same plan returns the same completed transaction.

## Error handling and testing

The test surface is intentionally small:

1. one contract test proves exact rc.2 compatibility and one-field/source-hash drift failure with zero writes;
2. one Core recovery test injects a fault after artifact mutation and proves artifact, workspace, projection, coordinator, and query state return to the captured digest;
3. one end-to-end synthetic fixture test proves strict-prefix apply, verified ref movement, idempotent repeated apply, and zero writes for a divergent plan.

Existing phase-one tests remain regression gates at batch close, but the implementation does not add a combinatorial fault matrix or browser tests.

## Upgrade boundary

Each DSH release receives a new host adapter and fingerprint. Updating hashes in place is forbidden. A future `0.1.1-rc.3` or `0.1.2` adapter must prove the same capture/apply/restore interface independently before Maintenance enables it.
