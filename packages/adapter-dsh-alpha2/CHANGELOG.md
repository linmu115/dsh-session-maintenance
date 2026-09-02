# Changelog

## Unreleased

- Keep live append metadata synchronized with each durable receipt so the next
  Alpha2 event targets the derived logical session and current canonical base.
  Recovery supersedes stale-metadata WAL evidence before replaying the proven
  native tail, whether the stopped run is still held in memory or restored
  after an Engine restart.
- Recover a partially applied native batch by proving its identical committed
  prefix and appending only the missing suffix.
- Align crash-tail recovery with Alpha2's restore lifecycle: a tail containing
  only `session/end-seed`, permission, sandbox and approval preparation is not
  treated as a user continuation. If a real continuation follows, the entire
  contiguous prelude and continuation are recovered together.
- Expose the same deterministic preparation-only classifier through the public
  adapter contract so projection recovery can retain an interrupted WAL record
  as superseded evidence instead of replaying it as a false canonical branch.
- Ignore Alpha2's unmapped composer shell when it contains only permission,
  sandbox and approval preparation during shutdown recovery. Any real event
  remains fail-closed. The ignored shell emits an
  `unmapped-preparation-shell-superseded` breakpoint.
- Make native session registration idempotent and recover a crash-window
  registration that exists only in the temporary Alpha2 projection. The
  recovered session is created as Maintenance-native, assigned to its project
  and then accepts the pending native tail through the normal WAL path.
- Preserve the nested Alpha2 recovery failure in the lifecycle diagnostic and
  allow the bounded finalization request to run for the same large-projection
  window as preparation.
- Replay the exact immutable canonical head body, including the frozen Codex
  base of a DSH-derived session, before validating Alpha2's contiguous native
  sequence.

- Project canonical Codex tool calls and results as native Alpha2 `tool/call`
  and `tool/result` events with correlated call IDs and identified tool-result
  messages. Imported tools now render as tools rather than user-authored text.

- Materialize canonical Codex turns as current Alpha2 identified message
  objects (`id`, `role`, `source`, `content`) instead of passing the Codex
  `{ text, attachments }` storage shape to `Session.create()`.
- Preserve uncorrelated foreign tool records under ignorable Maintenance event
  types rather than emitting malformed native `tool/result` events.

- Encode Maintenance logical IDs into deterministic, path-safe Alpha2 native
  session IDs. This matches Alpha2's `per-record` storage contract and prevents
  projection-cache startup failure on the former colon-prefixed IDs.

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
