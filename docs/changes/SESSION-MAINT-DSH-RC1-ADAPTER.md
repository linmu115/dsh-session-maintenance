# Session Maintenance: DSH 0.1.2 RC1 Adapter

Date: 2026-09-04

## Scope

This change adds a separate `dsh-rc1` format-family Adapter for the official
DeepSeek Harness `0.1.2-rc.1` release. It does not modify Launcher profiles,
Obsidian integration, Resource Management, or official DSH context compaction
configuration.

## RC1 contract changes handled

- `Session.events` is no longer treated as the live-history source. The plugin
  queues the emitted `session/event` directly and calls
  `snapshotEvents(fromOffset, toOffsetExclusive)` only after detecting a gap.
- RC1 lineage is represented by `SessionHeader.isSeeded` and a separate
  `inheritedEventCount` `SessionLogOffset` passed to
  `SessionPersistence.create`.
- Live-created fork lineage crosses the shared Broker only as opaque
  Adapter metadata. The RC1 Adapter alone validates it, so Alpha2 semantics
  are not widened and a seeded fork can register before its first append.
- Crash-tail recovery validates logical `{ isSeeded }` headers separately
  from physical JSONL `{ seedLength }` rows and proves their inherited-count
  equivalence before accepting a tail.
- Projection-cache identity includes `createdAt`, `cwd`, `isSeeded`, and
  `inheritedEventCount`. Legacy cache rows without lineage fields are treated
  as the official unseeded defaults.
- `SessionSeq`, `SessionSeqCursor`, and `SessionLogOffset` are validated as
  distinct Adapter-boundary values, including rejection of negative zero.
- Runtime attach and crash-tail recovery select the RC1 bridge only when the
  exact `dsh-rc1` Adapter is selected.
- The external lifecycle provider recognizes `0.1.2-rc.1` and pins that launch
  to `dsh-rc1`.

## Preserved invariants

- Maintenance is the canonical DSH session source.
- Codex rollout, index, SQLite, WAL, and SHM files remain read-only.
- Cold sessions remain catalog-visible and hydrate on demand.
- Project and workspace relations, titles, branches, and stable logical IDs
  remain canonical metadata rather than native RC1 ownership.
- Tool-call/result correlation and the MCSF `other` quarantine remain in
  force; unsupported evidence cannot leak into user or assistant messages.
- `session/flush` remains the durability barrier and waits for queued append
  receipts.
- DSH's official Token Meter, compaction-basic, command-compact, tool-result
  pruner, and preset configuration are not replaced or disabled.

## Compatibility boundary

`dsh-rc1` declares and verifies only `0.1.2-rc.1`. A later incompatible DSH
release must receive another Adapter package rather than a compatibility branch
inside this one.

## Focused verification

- RC1 Adapter typecheck and synthetic materialize/inspect/normalize/recovery
  tests.
- Plugin projection-runtime tests for direct sequential append, offset-gap
  snapshot repair, seeded live registration/first append/flush, RC1 lineage
  hydration, cache identity, and retry.
- Engine registry, runtime bridge selection/recovery, and external lifecycle
  selection tests.
- Portable package verification confirms the standalone Engine carries an
  executable `dsh-rc1-rpc-worker.mjs`.

Real RC1 Profile UI, model, compaction, and Obsidian acceptance remain separate
manual checkpoints after installation; this source change does not claim those
end-to-end checks.
