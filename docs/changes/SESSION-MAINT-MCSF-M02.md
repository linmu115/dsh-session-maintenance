# M02 — Adapter Evidence Port

## Outcome

Unknown source payloads created by the Codex read path and the DSH Alpha2
append path are now stored behind an Adapter-owned, content-addressed evidence
reference. New MCSF `other` events keep only a bounded description and
`evidenceRef`; their public `rawPayload` must be null.

## Changes

- Added the `AdapterEvidencePort`, evidence input/receipt DTOs and schemas.
- Added schema v13 with `adapter_evidence` metadata and the
  `adapter.evidence` runtime status stage.
- Reused the existing Zstandard content object store for immutable evidence.
- Scoped evidence reads by both reference and owning Adapter ID.
- Included evidence objects in the repository GC reachability set.
- Updated Codex import to preserve unsupported envelopes through the
  `codex-read` evidence owner while keeping their payload out of MCSF.
- Updated Alpha2 append normalization so unknown native event types become
  MCSF `other`, not legacy `opaque-unknown`; recognized events are unchanged.
- Added `adapter.evidence` status entries containing only result counts and
  digests, never payload data.

## Safety boundaries

- No real Codex or DSH home was written.
- No evidence read is available from the ordinary canonical session API.
- A different Adapter ID cannot use the evidence port to read the payload.
- Evidence write failure aborts the canonical append instead of silently
  dropping the native record.
- Historical canonical `rawPayload` records are not bulk-migrated in M02.
- RC2 behavior is intentionally unchanged; the first implementation target is
  DSH Alpha2 only.

## Focused verification

- Contract validation rejects non-null `rawPayload` on new MCSF `other`.
- Evidence storage is idempotent, Adapter-scoped and retained by GC.
- Schema upgrades preserve prior status rows and accept `adapter.evidence`.
- Alpha2 unknown native payloads are absent from public canonical events.
- Codex unsupported envelopes leave only an evidence reference and remain
  no-op on a repeated unchanged import.
- Projection append diagnostics include the evidence breakpoint.
