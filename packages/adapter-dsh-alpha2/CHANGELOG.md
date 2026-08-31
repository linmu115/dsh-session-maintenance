# Changelog

## Unreleased

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
