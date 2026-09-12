# Compatibility and evidence

Fixed source: DSH tag `dsh-v0.1.5-rc.2`, `fb2c4b9e698e30edb738bca4cf0618587db7d203`. All directly used DSH catalog/migration packages are pinned to `0.1.5-rc.2`. Keep the workspace lock with the candidate release. Node 24.7+ is the tested runtime.

The read-only private provenance seam reads the migration stages' source-coordinate maps; public stages still perform transformations. Missing or changed maps fail rather than silently guessing coordinates. Converter identity, source/target digest, per-source output coordinates, original information envelopes, source-owner export digests and canonical version are recorded in each projection's conversionLedger. v1 chunk rows have zero standalone output rows because their content is carried by the official stream representation.

Headers supplied by source exports retain lineage and header metadata through official migration. A canonical-only source without header evidence can only supply its existing canonical metadata; a seeded history without a provable inherited cut fails strict V3 validation. This implementation does not reconstruct discarded historical header fields from live homes. It never rewrites a canonical version.

`dsh-runtime/detail` is the only audited legacy information converter. Envelope surface operations or unconverted coordinate-bearing payloads are refused. Placement inside a collapsed stream requires a dedicated converter and is refused. Other ignorable native V3 events may be readable by the host but cannot be committed as fully adapted canonical records without a classified converter.

Focused tests cover exact/mixed probes, official V3 model reconstruction, source-owner evidence, detail placement, fork/end-seed, system prompt replacement, PTC, prune and surface coordinates, raw/zstd generations, future/conflicting/corrupt refusal, deterministic tail recovery, V3 replay and instance-scoped message resolution. Core tests additionally use the actual released JSONL service to exercise write-handle close, restored prefix cold read, a fresh writer and removal of a newly created artifact.

These are synthetic temporary fixtures. Combined deployed host, Runtime cards, actual attachments, two restart cycles and crash recovery of the copied user instance remain the main reviewer's acceptance work. No real home, canonical database or Vault is written by this work.

Confirmed upstream migration refusal: the released V0 composite fixture has surface messages before its first step. RC2 rejects this chronology because it cannot add its system head safely; the adapter preserves that refusal. Such source sessions need an independently reviewed semantic conversion before deployment can claim complete migration.
