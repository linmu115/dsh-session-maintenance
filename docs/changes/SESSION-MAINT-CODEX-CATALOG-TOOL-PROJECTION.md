# Codex catalog and tool projection repair

Date: 2026-09-02

## Failure boundary

The Codex catalog imported every row from `state_5.sqlite`, including Guardian
approval sessions and spawned worker sessions. Those internal rollouts encode
their approval and tool transcript as a synthetic user message, which made DSH
show tool payloads as user text and polluted titles. Separately, recognized
Codex tool records were downgraded to metadata instead of Alpha2 tool events.

The former stable-read contract also rejected any rollout that grew between
catalog enumeration and body observation. That prevented a hot import of the
currently active Codex task. Finally, a verified candidate larger than 2 GiB
failed only while `readFile()` calculated its final digest.

## Repair

- Classify user-visible Codex rows from `source` and `agent_role`; omit
  `subagent.other=guardian`, `subagent.thread_spawn` and other agent-role rows.
- Keep normal root tasks and formal `source=vscode` delegation tasks.
- Use Codex's concise task name/title and never infer a title from approval
  transcript text. When an old task has no generated name, unwrap the explicit
  `## My request` or DSH continuation title instead of displaying attachment or
  ambient-browser scaffolding.
- Normalize `custom_tool_call`, `custom_tool_call_output`, `function_call` and
  `function_call_output` as correlated canonical tool events.
- Materialize those canonical events through Alpha2's native `tool/call` and
  `tool/result` contract.
- Read the exact byte prefix captured at observation start. Append-only growth
  is accepted; replacement or truncation remains retryable and fail-closed.
- Record catalog, bounded-prefix, canonical-import and per-session reseed
  status entries. Hash large candidate databases through a stream.
- Provide a recoverable reconciliation command that creates one Checkpoint and
  hides already imported internal Codex mirrors without modifying Codex.
- Rebuild the latest canonical event index when a normalization upgrade changes
  the meaning of an existing source event. Immutable version bodies continue to
  preserve the old representation.
- Load projection events from the immutable head body so derived sessions carry
  their frozen Codex base and their DSH tail as one contiguous replay.
- Bridge Alpha2's resume boundary by collecting the hidden `session/end-seed`
  marker from the session snapshot before the first published event. Defer the
  automatic permission/sandbox/approval prelude until a real continuation so a
  read-only open does not fork a Codex-owned session.

## Focused acceptance evidence

- Codex adapter tests cover Guardian/worker filtering, visible delegation,
  bounded-prefix append acceptance, truncation rejection and tool pairing.
- Canonical import and Alpha2 projection tests cover native tool call/result
  shapes.
- The active canonical store contains 317 Codex user tasks plus ten retained
  Maintenance-owned/native sessions. Its 165 previously imported internal
  threads are tombstoned behind Checkpoint
  `checkpoint-codex-internal-30e5944a-3ac9-4b52-91a3-04d366f7e004` without
  changing Codex truth.
- The active store contains 153,112 tool calls and 153,090 tool results, with no
  active internal bindings, wrapper-polluted titles or missing project/workspace
  memberships. All 327 active sessions replayed successfully through the
  official Alpha2 `Session.create` implementation.

Interactive Alpha2 acceptance opened a hot Codex session with its formal task
title, `dsh` project and native tool rows, then hydrated an 80-event cold Codex
session under `MinerU` on demand. The cold replay exposed the resume-boundary
gap above; the focused runtime test now covers that exact sequence before the
final restart acceptance.
