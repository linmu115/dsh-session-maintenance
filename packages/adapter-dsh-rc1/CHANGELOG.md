# Changelog

## Engine 0.1.15 recovery fix - 2026-09-06

- Treat omitted logical `delegationDepth` as zero when comparing the official
  persisted RC1 header. The JSONL writer already persists this optional field as
  `header.delegationDepth ?? 0`; a normal unseeded session could otherwise block
  shutdown recovery and retain the single-writer lease indefinitely.
- Keep nonzero delegation depth, creation time, preset, lineage and committed
  event-prefix checks strict. No native artifact, version or receipt is edited
  to force recovery. Add five focused positive and negative regressions.
- This private embedded reader fix leaves the 0.1.2 projection/cache format
  unchanged. Engine 0.1.15's source commit and package digest identify the build.

## 0.1.2 - 2026-09-05

- Preserve RC1's known turn/step, request and seed controls as native
  `system-metadata` during native appends. Previously they became `other`,
  removing the enclosing lifecycle on the next projection and causing
  `assistant/chunk ... open is turn null/step null` startup failures.
- Keep portable lifecycle records evidence-only and unknown events isolated.
- Include the logical session ID and failing event sequence in inspection
  failures; do not bypass the RC1 relational checks.
- Add native append/materialize/reload roundtrip regression coverage.

## Unreleased

- Accept user steering after model work inside a Canonical turn, preserving
  encounter order and the existing tool-call/result step coordinates.
- Reject a single explicit model step spanning both sides of a user steering
  message: RC1 Chat would otherwise overwrite an earlier response, or merging
  its content would move a later response before the user.
- Mark projected histories as `native` or `portable` and preserve that mode
  across later durable appends.
- Convert portable RC1 appends into exact MCSF user, assistant, reasoning,
  tool-call and tool-result events before replanning conversation topology.
- Keep RC1 lifecycle, streaming chunks and request-context envelopes as
  evidence-only transport details when appending to a portable history.
- Add a migration helper that converts an existing derived conversation's
  retained native RC1 suffix without changing its event identities or content.
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
