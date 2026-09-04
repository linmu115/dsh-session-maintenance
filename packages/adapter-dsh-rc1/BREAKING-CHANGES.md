# DSH 0.1.2 RC1 breaking changes handled

The Adapter is based on the official `0.1.2-rc.1` npm artifacts for
`@deepseek-ai/dsh`, `@deepseek-ai/dsh-session`,
`@deepseek-ai/dsh-session-persistence`, and the JSONL persistence package.
No user session log is used as a fixture.

Compared with the Alpha2 format family, RC1 requires:

- `SessionHeader.isSeeded` as the logical lineage flag;
- `inheritedEventCount` as a `SessionLogOffset`, distinct from an event
  `SessionSeq` even though both are encoded as numbers;
- `SessionPersistence.create(header, inheritedEventCount?)` instead of
  relying on the old header-only seed shape;
- projection-cache identity to include `createdAt`, `cwd`, `isSeeded`, and
  `inheritedEventCount`;
- live session updates to consume the emitted event directly. A bounded
  `snapshotEvents(fromOffset, toOffsetExclusive)` read is used only when an
  offset gap is detected;
- `session/flush` to remain the durable barrier after all queued appends have
  received Maintenance receipts.
- fresh native execution traces to start at turn one and step one, with every
  assistant/tool event enclosed by matching `turn/start`, `step/start`,
  `step/end`, and `turn/end` records;
- tool results to cite a prior `tool/call` in the same open step.

Maintenance-owned projections are created unseeded with
`inheritedEventCount = 0`. The JSONL package may still encode lineage as the
physical `seedLength` field; that is an RC1 storage detail handled only by the
Adapter recovery boundary.

The following invariants are unchanged:

- Maintenance remains the canonical source;
- Codex rollout and index files are read-only;
- project and workspace relations remain separate canonical metadata;
- cold sessions stay catalog-visible and hydrate on demand;
- tool calls/results retain correlation and unmatched evidence stays outside
  model-visible history;
- official DSH compaction and Token Meter configuration is not replaced or
  disabled.

Portable MCSF conversation rows are therefore accepted only when they carry
the typed Canonical topology extension. Old imported heads that lack it remain
untouched until the explicit, checkpointed M06 migration rebuilds and switches
their active versions.
