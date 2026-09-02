# Alpha2 imported tool-history pairing repair

Date: 2026-09-02

## Failure boundary

The Codex reader accepted `function_call_output` and
`custom_tool_call_output` rows without a protocol `call_id` by falling back to
the response row's unrelated `id`. That manufactured standalone canonical
tool results from internal coordination records.

The Alpha2 Adapter also emitted a canonical tool call only as the log-level
`tool/call` event. Alpha2 deliberately excludes `tool/call` from
`Session.deriveMessages()`, but includes `tool/result`. The resulting provider
request therefore contained `role: tool` without a preceding assistant
message containing the matching tool-call block, and the provider rejected the
turn as `INVALID_REQUEST`.

## Repair

- Require an explicit Codex `call_id` for every output row. An uncorrelated
  output remains recoverable source metadata and never enters the tool surface.
- Materialize each canonical Codex tool call as an identified Alpha2
  `assistant/message` with a `tool-call` block, followed by the native
  log-level `tool/call` envelope.
- Correlate the subsequent `tool/result` through the exact materialized
  `tool/call` sequence in `sourceEventSeqs`.
- Rebase native event and provenance sequences when the assistant message is
  inserted, including mixed imported and runtime-appended sessions.
- Downgrade an already stored unmatched canonical tool result to ignorable
  `maintenance/orphan-tool-result` evidence instead of exposing it to the
  model request.

## Focused acceptance evidence

- Codex Adapter fixture: an output without `call_id` is degraded to metadata.
- Alpha2 request-history fixture: `assistant/message -> tool/call ->
  tool/result` preserves one call ID and leaves no orphan derived result.
- Alpha2 defensive fixture: an unmatched historical result has no surface
  operation and cannot enter `Session.deriveMessages()`.
- Focused Codex import tests, all Alpha2 Adapter tests, Adapter typechecks and
  Engine typecheck pass before runtime deployment.
