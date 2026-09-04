# M02 — Codex Semantic Classification and Turn Topology

## Outcome

The Codex Read Adapter now owns the decision about which Codex rollout rows
have portable conversation meaning. The Engine consumes a typed Adapter
classification and no longer opens raw Codex envelopes to guess event kinds or
roles.

Portable events are limited to:

- user and assistant messages;
- visible reasoning summaries/content;
- custom and function tool calls with an explicit `call_id`;
- tool results with the matching explicit `call_id`.

Known Codex lifecycle and audit rows remain source evidence and do not become
Canonical conversation events. This includes session metadata, turn context,
task/turn lifecycle notifications, presentation duplicates, token usage,
world state and compaction boundaries.

## Source contract

The classification follows Codex's published protocol rather than field-name
guessing:

- `ResponseItem` defines messages, reasoning, function/custom calls and their
  outputs, including `call_id` and per-item turn metadata;
- rollout persistence separately records lifecycle `event_msg`,
  `turn_context`, `world_state` and `compacted` envelopes;
- `task_started` and `task_complete` are legacy wire names for turn lifecycle.

References:

- <https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs>
- <https://github.com/openai/codex/blob/main/codex-rs/rollout/src/policy.rs>
- <https://github.com/openai/codex/blob/main/codex-rs/docs/protocol_v1.md>

## Adapter and Engine behavior

Every emitted normalized event carries `codex.canonicalSemantics.v1`, with a
portable Canonical kind/role or an explicit MCSF `other` reason. Conversation
events also carry the Codex turn identity when present. The pure topology
planner fills deterministic step coordinates after tool-pair analysis.

The Engine:

- requires the typed Adapter classification;
- never derives meaning from `codexEnvelope`;
- rejects tool events without an explicit `call_id` instead of inventing one;
- persists raw evidence only for genuine `other` events;
- emits count-only `codex.classification` and `codex.topology.plan` status
  checkpoints.

Unknown source records remain MCSF `other`, with their raw payload confined to
the Adapter evidence store. Empty/non-portable reasoning and known lifecycle
rows do not create visible maintenance cards.

## Boundaries

- Codex remains strictly read-only; no source rollout or catalog is changed.
- No Canonical database migration or head switch runs in M02.
- No DSH Adapter, Launcher, profile, model, compaction or live projection path
  changes.
- No fake tool results, tool IDs, chunks, turns or lifecycle events are
  manufactured.
- Existing Canonical versions remain untouched until the explicit M06
  migration.

## Focused verification

- official-shaped two-turn rollout with lifecycle rows, reasoning and a tool
  pair;
- lifecycle rows excluded while explicit turn IDs and encounter order remain;
- custom/function calls and results preserve exact `call_id` pairs;
- missing `call_id` becomes non-model `other` evidence and cannot become a
  tool result;
- compacted replacement history stays active without a visible compaction
  card;
- Engine imports typed semantics, adds step topology and keeps Codex Home byte
  unchanged;
- malformed tool semantics fail closed.

All verification uses synthetic fixture homes and temporary databases.
