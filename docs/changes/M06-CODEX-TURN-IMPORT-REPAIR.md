# M06 — Codex turn namespaces and generated warning classification

## Located source contracts

The prior frozen snapshot failed RC1 turn-contiguity validation for 14
conversations. Across that snapshot, 522 tool pairs had inconsistent assigned
turns. A read-only source check confirmed a call/result pair with the same
`call_id` belonged to one enclosing task, while their response-item metadata
contained different turn IDs. The adapter incorrectly preferred those inner
IDs over `task_started` / `turn_context`.

Official pinned references, retrieved through GitHub's contents API:

- [Codex protocol at rust-v0.146.0](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/protocol/src/protocol.rs):
  `TurnStarted` uses the legacy wire name `task_started`; `TurnComplete` uses
  `task_complete`. The `turn_started` / `turn_complete` aliases are supported.
- [LegacyApplyPatchExecCommandWarning at rust-v0.146.0](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/context/legacy_apply_patch_exec_command_warning.rs):
  Codex explicitly identifies the old warning as a `ContextualUserFragment`
  with role `user`, retained for filtering historical sessions rather than as
  human conversational input.

The earlier web/raw-source routes were unavailable. The versioned GitHub API
source was successfully retrieved; these conclusions do not rely on search
snippets or a guessed later version.

## Implementation boundary

- Within an active rollout task/context, assign the enclosing task turn.
  Retain per-item metadata as a fallback only when no enclosing turn exists,
  including legacy or compacted response-only histories.
- An end event carrying an old turn ID cannot clear a newer active task.
  End events without an ID retain the legacy clear-active-turn behavior.
- Recognize the official legacy patch-warning text only as a complete,
  single `input_text` user fragment without a DSH-import override. In addition,
  require a preceding tool call and following patch execution notification
  and tool output carrying the same exact call ID.
- Keep standalone/quoted warnings, attachments, real steering and unrelated
  call contexts visible. Do not broadly filter `Warning:` or rewrite model
  message order to satisfy provider validation.
- The generated warning is evidence-only in the source, not a user bubble,
  fabricated tool result or visible MCSF unknown card. Its original Codex
  envelope remains untouched.
- Candidate-only derivation filtering and fork validation are documented in
  [M06-DERIVED-BOUNDARY.md](M06-DERIVED-BOUNDARY.md).

## Verification checkpoints

- 59 focused tests passed across eight files: Codex reader/schema, shared
  topology, RC1 tool projection, frozen plan, canonical import, candidate
  migration, and the derived fork-boundary helper.
- Codex Reader and Engine typechecks and builds passed.
- A new read-only preview captured 331 selected Codex conversations; no reads
  needed retry. Source revision remains 25340. The active candidate derivation
  selection is now one child, not eleven including deleted records.
- A hash-checked, one-session-at-a-time in-memory preflight passed all 332
  mirror/active-child projections through the actual RC1 materializer and
  inspector. Assigned cross-turn tool pairs: zero. User messages interrupting
  a pending projected tool pair: zero. This is offline protocol validation,
  not a live model or browser acceptance test.
- The active child's old base has 521 source events; the repaired parent has
  302. Its original 109-event native DSH suffix remains in immutable history;
  portable conversion yields the conversation subset while retaining the
  source evidence. Source-order fork validation passed before staging.

## State boundaries

Only the new plan capture and inactive candidate may be written. Codex source,
active Maintenance heads, Launcher, Profile, official compaction/model
configuration and running processes are unchanged by this task. Deleted
children are not restored. Old versions, the earlier failed candidate and the
quarantined run are retained.

Plan digest:
`f273e71db71a2c1477b8c64ff1a1a57fc8181960895711f94db66511ff5262b3`

Reviewed source digest:
`11668d1f34bf3ecf9b176c6f8fecc1e508eaebbef944c0c03ca0899752d56a84`

## Inactive candidate result

`metadata.conversation-repair-20260905-r3.sqlite` reached
`repair.candidate-ready:succeeded` after validating all 332 affected sessions.
The candidate contains four new mirrors, 327 refreshed mirrors, and one
recomposed active derived conversation. The 165 retired mirrors remain
retired, and all 13 deleted derived conversations remain deleted.

- Integrity check: `ok`; foreign-key violations: zero.
- Source revision: 25340; inactive candidate revision: 51613.
- Missing old session IDs or old Session Versions: zero.
- Changed old Session Version rows (all columns compared): zero.
- Changed deleted-child heads/deletion markers: zero.
- Changed existing tombstone operation/checkpoint/restore fields: zero.
- Changed existing derivation parent/base relationships: zero.
- Seven non-Codex native session heads checked: zero changed.
- Active database configuration is unchanged; no active projection writer
  existed at the final check. No candidate activation or process restart ran.

Checkpoint: `checkpoint-m06-072a5bd3-b061-46bd-8566-2b1caf69b882`

Candidate digest:
`sha256:a168b794c1be8a4b8075758eadd62d5cbc149a129a5ce60e02f1320a9c1e7cdd`

This READY result covers the offline projection and database checks above,
not browser/model acceptance or a blanket guarantee about external reference
anchors across a topology-changing historical migration.

## Remaining activation boundary: reference identity

A final read-only comparison of the old database and the frozen r3 plan found
that source identity is stable but normalized identity is not. Among 331
planned mirrors, 40,720 retained source identities matched their prior source
occurrence; all of their canonical event IDs changed, across 326 sessions.
`packages/session-domain/src/normalize.ts` hashes sequence, content and
extensions as well as source identity. This migration changes those semantic
fields, so it cannot promise unchanged canonical event IDs.

The sole active derived conversation provides a narrower concrete case:

- Its 302 repaired parent events retain the old base's source identity and
  order, but have new canonical event IDs.
- All 18 portable suffix event IDs remain unchanged; 16 content digests are
  unchanged and two assistant digests change with the portable representation.
- Six suffix messages retain their native message ID in portable `content.id`.
  In the actual in-memory RC1 projection, all four user IDs remain intact,
  while the two assistant IDs are replaced by canonical event IDs.
- The assistant assembly in `packages/adapter-dsh-rc1/src/materialize.ts`
  chooses a canonical event ID or a synthetic step ID; unlike the user path,
  it does not reuse a sole message's `content.id`.
- `resolveRc1Reference` currently passes through the logical anchor unchanged;
  it supplies neither a historical alias nor an existence check.

This proves a projected-ID change, not a proven broken external link. The
old store did not contain annotation/sticker/reference events establishing an
affected link, and external notebooks were not scanned. The inactive READY
candidate has therefore not been activated. A separately reviewed identity
preservation/alias strategy and focused reference acceptance are required
before claiming that this topology repair preserves existing deep links.
No reference protocol or ID algorithm was changed in this three-fix batch.
