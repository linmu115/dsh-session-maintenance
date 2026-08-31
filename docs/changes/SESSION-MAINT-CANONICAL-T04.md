# T04 — Canonical session engine

## Scope

This task adds the platform-neutral canonical session engine. It decides whether
a Codex observation is new, advanced, or unchanged; commits DSH-native appends;
defines the delayed Codex-to-DSH derivation transaction; and applies deletion
tombstones and restores. It does not read either platform, materialize a DSH
projection, or emit runtime P4/P5 status events.

## Changes

- Added the `@linmu/dsh-canonical-session-engine` workspace package.
- Added canonical version records whose body, metadata, and content digests use
  the existing deterministic session-domain JSON and SHA-256 functions.
- Added a single `CanonicalSessionEngineStore.commit` boundary that requires a
  store implementation to atomically persist the content object, version head,
  workspace membership, derivation, projection receipt, tombstone, and engine
  receipt supplied by one mutation.
- Added Codex observation handling:
  - first observation creates one `codex-mirror` logical session;
  - changed canonical content advances the same logical session;
  - unchanged content records the new source cursor without creating a version;
  - a tombstoned Codex mirror may advance while remaining detached and hidden.
- Added DSH append handling:
  - a first native append creates a `maintenance-native` session;
  - later appends advance its immutable version graph;
  - operation receipt lookup occurs before event computation, making replay a
    no-op;
  - first write to a Codex mirror creates one `codex-derived` child transaction,
    inherits title, tags, and logical workspace, and records cross-session
    lineage without a fake same-session parent edge.
- Added tombstone and restore mutations that preserve every immutable version,
  detach/restore workspace membership, and return explicit deleted/restored
  tombstone receipts.
- Added `created`, `advanced`, `noop`, `derived`, and `tombstoned` engine outcomes.

## Focused verification

Commands:

    pnpm exec vitest run packages/canonical-session-engine/test/engine.test.ts
    pnpm --filter @linmu/dsh-canonical-session-engine typecheck

Results:

- 1 test file and 4 tests passed.
- The new package typecheck passed.
- A changed Codex cursor with unchanged canonical content creates no version.
- Codex incremental content advances one logical session and links the previous
  version as its only parent.
- DSH operation replay returns the original receipt without a second mutation.
- Delayed derivation inherits source metadata/workspace even when DSH supplies
  different values.
- Delete and restore leave the immutable version count unchanged.

## Breakpoint policy

The four planned engine breakpoints passed. During self-review, the tombstone
interval exposed one narrower semantic risk: a later Codex import could have
reattached a hidden mirror to its former workspace. A regression assertion was
added inside that existing breakpoint and the membership choice now preserves
the detached state. No broader test matrix or child runtime status stage was
added.

## Safety

- Verification used only an in-memory store implementation.
- No real Codex or DSH home, Maintenance database, projection, or Launcher
  Profile was read or written.
- The package defines the delayed-derivation transaction entry but does not
  connect it to a live DSH Runtime Bridge.
