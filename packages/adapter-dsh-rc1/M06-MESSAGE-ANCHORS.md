# M06 RC1 message identity and verified anchors

## Scope

This change is confined to the RC1 adapter and synthetic tests. It does not edit
canonical history, production databases, profiles, running processes, or the
Obsidian reference protocol. The parent task owns shared reader wiring and Codex
source-identity preservation.

## Behavior

- A single assistant-message source in a step preserves its nonblank embedded
  message ID, using the same flat/nested message decoding as user messages.
  Missing, blank, or non-string IDs fall back to the canonical event ID.
- Multi-source reasoning, assistant text, and matched tool calls retain the
  existing aggregate message ID and tool correlation. A portable payload-local
  `anchorAliases` map links contributing canonical event IDs and available
  historical message IDs to the actual output message ID. This metadata is not
  inserted into SessionEvents or model content.
- Duplicate output message IDs and aliases that point at different messages
  fail materialization through the existing per-session TypeError boundary.
  Retired evidence-only rows and unmatched calls/results receive no fabricated
  message target.
- Reference resolution accepts an optional read-only ProjectionReader, prefers
  the current supplied native session mapping, checks logicalSessionId/header.id,
  and validates that the alias target is exactly one append-origin message.
  Unknown, stale, ambiguous, or missing targets return unavailable. Native legacy
  payloads without alias metadata can still resolve their actual message IDs.
  Without a reader, only a null-anchor session reference resolves.
- The adapter declares `verified-anchor-resolution` and advances its package and
  manifest version to 0.1.1 so projection cache fingerprints invalidate old
  payloads.

## Verification

- `pnpm exec vitest run packages/adapter-dsh-rc1/test`: 9 files, 52 tests passed.
- `pnpm exec tsc -p packages/adapter-dsh-rc1/tsconfig.json --noEmit`: passed.
- New focused coverage: 13 tests for native-to-portable-to-RC1 user/assistant IDs,
  invalid and duplicate IDs, alias collisions, multi-source reasoning/tool and
  multi-assistant aggregation, mapped derived native session identities, legacy
  payloads, and fail-closed reference lookup.

No production migration, activation, restart, or git commit was performed by
this adapter subtask. Projection aliases guarantee an explicit target only for
events represented by an actual message; they do not promise anchors for retired
evidence or references stored outside the inspected projection.
