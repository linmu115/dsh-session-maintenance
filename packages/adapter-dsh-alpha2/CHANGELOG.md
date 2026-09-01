# Changelog

## Unreleased

- Add fail-closed Alpha2 crash-tail recovery for the official per-run JSONL and
  checksummed zstd persistence layouts. Recovery proves the committed prefix
  and contiguous native sequence before emitting a deterministic append.
- Decode recovery metadata from the temporary projection so a DSH-created
  session can be recovered before its first canonical commit while preserving
  project and workspace as independent relations.

- Stop accepting new native appends as soon as drain begins, while allowing the Engine to replay already durable WAL operations before detach.
- Switch a projected Codex session to its Maintenance-owned child identity only after the first DSH append commits; the native runtime session ID remains stable for the active run.
- Route native Alpha2 appends through a run-bound handler, validate contiguous revisions before WAL persistence, and update only the run-scoped temporary projection.
- Add the isolated Alpha2 Runtime Bridge. The DSH registrar receives only a run ID and Maintenance endpoint; the Engine-owned projection root never crosses the plugin configuration boundary.
- Add the typed probe worker used by Adapter Host and register the built-in Alpha2 Adapter during Engine composition.
- Include the complete workspace catalog in projection verification, including empty workspaces.

## 0.1.0 - 2026-08-31

- Add the first canonical projection Codec for DeepSeek Harness `0.1.2-alpha.2`.
- Materialize canonical sessions into Alpha2 format-version-0 headers and contiguous event envelopes.
- Normalize Alpha2 append batches into `CanonicalEventV1` records.
- Preserve unrecognized Alpha2 and plugin events as raw payloads and report them as held-out instead of discarding them.
- Add deterministic projection inspection, digest verification and stable reference resolution.
- Keep the declared DSH range open; exact package evidence determines `verified`, while runtime capability probing permits compatible and experimental builds.
