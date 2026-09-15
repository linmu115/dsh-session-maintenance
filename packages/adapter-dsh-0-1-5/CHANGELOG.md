# Changelog

## 0.1.2 — durable native session titles

The Adapter extracts the final valid `session/title` event into append metadata and records a bounded title projection from the already restored prefix. Existing registration placeholders no longer replace durable native names during materialization; sources without native titles retain canonical names. The manifest fingerprint changes while the cache key remains stable, forcing one rebuild of older retained caches even when canonical heads did not change.

## 0.1.1 — canonical V3 projection and immutable resources

Portable canonical histories now use a dedicated V3 builder. Ordered source receipts retain every canonical event verbatim, including reasoning and other log-only data; only policy-approved content reaches the model. Adjacent assistant/tool fragments keep content order, separate assistant fragments get distinct native steps, and aliases preserve original identities. Binary image/file sources become typed references with exact byte inventories. Broker prepare verifies and publishes immutable attachment objects before sessions become ready; the RC2 provider binds attachment-local to that same owned space.

Real-history read-only preflight: 38/38 live sessions accepted after the native source/detail fixes, 35 exact portable restoration and policy-filtered context checks, 19 attachment objects verified and fully decoded. Official CLI first/cold-reopen tests confirmed the actual attachment service reads the Broker-owned object despite a different DSH_HOME.

## 0.1.0 — fixed DSH 0.1.5-rc.2

Added adapter `dsh-0.1.5`, native format `dsh-0.1.5-v3-jsonl-zstd-v1`. Uses the released RC2 catalog and three migration edges, strict V3 validation, reread-verified checksummed zstd publication, generation selection and deterministic crash-tail recovery. Native revisions count accepted logical events; persistence stat revisions are never numeric checkpoints.

Audited Runtime detail rows retain original envelopes in the conversion ledger and become ignorable information rows without model-surface contribution. Unclassified events refuse conversion. Source adapters alone restore their own evidence. System messages, PTC, compaction coordinates and fork cuts follow the fixed upstream converter; stable message identities remain usable in target-scoped references.

No old adapter ID or old Core implementation is replaced.
