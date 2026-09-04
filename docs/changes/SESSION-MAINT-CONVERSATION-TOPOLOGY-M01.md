# M01 — Canonical Conversation Topology

## Outcome

MCSF v1 now has a typed, namespaced conversation-topology extension and a
pure planning Module. It gives later Codex import and DSH RC1 projection work a
shared definition of turn, step and phase without storing Harness-native replay
details in the canonical format.

The contract records:

- stable logical `turnId` and `turnOrdinal`;
- optional, paired `stepId` and `stepOrdinal`;
- `user`, `reasoning`, `assistant`, `tool-call` or `tool-result` phase;
- whether topology was source-explicit or deterministically derived.

## Planner behavior

`planConversationTopology()`:

- never sorts, rewrites or manufactures canonical events;
- preserves valid explicit MCSF topology;
- derives deterministic topology for legacy events that do not yet carry it;
- begins a new turn at each user message;
- advances to the next model step only after every call in the current tool
  batch has a matching result;
- reports malformed, duplicate, orphan and unclosed tool relationships;
- marks structurally unsafe history as ineligible for continuation instead of
  inventing a tool result.

Non-conversational metadata and evidence remain outside the conversation event
plan. Later Modules may group them for display, but they cannot widen them into
model-visible history.

## Boundaries

- No Codex, DSH, Launcher, Engine, Adapter or live projection path changed.
- No real Codex Home, DSH Home, canonical database or profile was opened.
- No schema migration or canonical head switch runs in M01.
- Native turn IDs and raw payloads remain Adapter-owned evidence.
- MCSF remains schema version 1; the new data is carried by
  `mcsf.conversationTopology.v1`.

## Breakpoint contract

When integration begins, callers can emit `codex.topology.plan` from the
planner receipt using counts only: input events, conversational events, turns,
steps, matched results, orphan results, unclosed calls and topology conflicts.
No message text or tool payload is needed in the status entry.

## Focused verification

- topology extension round-trip, malformed presence and safe-ordinal checks;
- two-turn derivation with an interleaved non-conversational record;
- multi-call tool batch closure and next-step transition;
- explicit topology preservation;
- unclosed call rejection with no synthetic result.

All tests use synthetic in-memory events.
