# Changelog

## 0.1.0 - 2026-08-31

- Add an isolated RC2 Codec and Runtime Bridge for `0.1.1-rc.2`.
- Materialize canonical sessions as RC2 version-0 session headers and contiguous event envelopes.
- Preserve unknown Annotation, Sticker, Obsidian and plugin events as held-out raw envelopes.
- Normalize RC2 append batches into `CanonicalEventV1` and resolve logical references to deterministic native IDs.
- Keep the declared version range open; exact fixtures verify RC2 while capability-compatible combinations remain experimental.
