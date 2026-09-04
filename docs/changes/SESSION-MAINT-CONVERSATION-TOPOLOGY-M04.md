# M04 — RC1 Native Conversation Lifecycle Projection

## Outcome

The exact-version `dsh-rc1` Adapter now consumes the typed MCSF conversation
topology and emits the lifecycle required by `@deepseek-ai/dsh-session`
`0.1.2-rc.1`:

1. `turn/start`;
2. zero or more identified `user/message` rows;
3. `step/start`;
4. one native assistant message containing reasoning, text and correlated
   tool-call blocks in Canonical order;
5. the matching `tool/call` and `tool/result` rows;
6. `step/end`;
7. `turn/end`.

Canonical zero-based turn and step ordinals become RC1's one-based native
coordinates. Inserted rows are resequenced contiguously, and tool-result
`sourceEventSeqs` point to the materialized `tool/call` sequence.

## Fail-closed boundaries

- Portable conversation events must carry
  `mcsf.conversationTopology.v1`; the Adapter does not infer turns from text,
  roles or event adjacency.
- A portable Canonical version cannot also contain RC1 core/native conversation
  envelopes. M06 must recompose such historical versions before activation.
- A tool call reaches the assistant surface only when exactly one result with
  the same `call_id` exists in the same Canonical turn and step.
- Missing, duplicate, cross-step and unclosed tool records remain ignorable
  Maintenance evidence. The Adapter never invents a result.
- Imported final assistant messages do not receive fabricated streaming chunks
  or fabricated `sourceEventSeqs`.
- Plugin-owned non-core native events may still round-trip as log-only rows.

## RC1 source evidence

The mapping was checked against the published `0.1.2-rc.1` npm artifacts:

- `@deepseek-ai/dsh-session` event types and relational invariant;
- `@deepseek-ai/dsh-session` model-surface derivation policy;
- `@deepseek-ai/dsh-llm` text, reasoning, tool-call and tool-result blocks.

The Adapter inspector now applies the same RC1 turn/step/tool relational subset
to every materialized session. A violation fails the existing P2
`projection.materialize` status breakpoint instead of reaching the live
profile.

## Focused verification

- a two-turn conversation is emitted with dense native turn and step numbers;
- reasoning is a native reasoning block rather than a maintenance card;
- two calls in one step preserve order and each result cites its own call;
- a final assistant response after tools occupies the next RC1 step;
- orphan results remain off the model surface;
- sparse Canonical sequences rebase to a contiguous RC1 log;
- a portable row without Canonical topology is rejected;
- existing raw RC1 packed rows and plugin-owned held-out events still round-trip.

All tests use synthetic sessions and temporary in-memory writers. No live
Codex source, Canonical database, Launcher profile or DSH Home is changed.
