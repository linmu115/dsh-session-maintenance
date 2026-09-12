# Changelog

## 0.1.0 — fixed DSH 0.1.5-rc.2

Added adapter `dsh-0.1.5`, native format `dsh-0.1.5-v3-jsonl-zstd-v1`. Uses the released RC2 catalog and three migration edges, strict V3 validation, reread-verified checksummed zstd publication, generation selection and deterministic crash-tail recovery. Native revisions count accepted logical events; persistence stat revisions are never numeric checkpoints.

Audited Runtime detail rows retain original envelopes in the conversion ledger and become ignorable information rows without model-surface contribution. Unclassified events refuse conversion. Source adapters alone restore their own evidence. System messages, PTC, compaction coordinates and fork cuts follow the fixed upstream converter; stable message identities remain usable in target-scoped references.

No old adapter ID or old Core implementation is replaced.
