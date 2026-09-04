# Changelog

## Unreleased

- Project portable MCSF conversations through RC1's native one-based
  turn/step lifecycle instead of hard-coding turn and step zero.
- Combine reasoning, assistant text and correlated calls into the native
  assistant message for each model step.
- Keep incomplete, duplicate, orphan and cross-step tool records off the model
  surface without manufacturing tool results.
- Reject portable conversation rows without the Canonical topology extension,
  and validate generated logs against RC1's published relational invariants.
- Group genuine MCSF `other` rows into at most one log-only card per Canonical
  turn or contiguous outside-turn region.

## 0.1.0 - 2026-09-04

- Add the exact-version Adapter for DeepSeek Harness `0.1.2-rc.1`.
- Model RC1 `SessionSeq` and `SessionLogOffset` as distinct protocol values.
- Materialize Maintenance sessions with explicit `isSeeded: false` and
  `inheritedEventCount: 0` lineage.
- Verify RC1 persistence and projection-cache identity fields.
- Add the RC1 Runtime Bridge and crash-tail recovery boundary while preserving
  the physical JSONL `seedLength` encoding used by the official package.
- Carry live seeded-fork `inheritedEventCount` as RC1-owned Adapter metadata,
  and validate logical `isSeeded` separately from physical `seedLength` during
  crash-tail recovery.
- Reject negative-zero `SessionSeq`, `SessionLogOffset`, and physical
  `seedLength` values at the Adapter boundary.
- Keep MCSF `other` evidence ignorable and off user, assistant, and tool-result
  message surfaces.
- Declare only `0.1.2-rc.1`; later incompatible Harness releases require a new
  Adapter package.
