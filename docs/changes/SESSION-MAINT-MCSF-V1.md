# SESSION-MAINT-MCSF-V1

Date: 2026-09-03

## User-visible outcome

- Session Maintenance now has an explicit first-version canonical session
  vocabulary named MCSF v1.
- Source records that have no exact shared meaning are shown in DSH as a
  collapsed Maintenance card, not as user text, assistant text or a model tool
  result.
- Existing legacy canonical records remain readable.

## Modules and seams changed

- Contracts Module: added the `other` kind, its strict content schema and a
  fixed projection policy.
- Codex import Adapter: classifies unsupported envelopes as `other`; it stores
  a normalized summary and evidence digest rather than exposing the raw
  structure in a conversation message.
- Alpha2 Adapter: maps `other` to an ignorable non-Surface event and refuses to
  replay a raw message-shaped payload for this class.
- DSH plugin: registers one Conversation node definition and one tool-style
  card renderer for the log-only event.
- Session Store: migration 011 expands the event-kind constraint without
  rewriting legacy `opaque-unknown` rows.

## Compatibility and safety

- No real Codex or DSH Home is written by the change or its tests.
- No Launcher lifecycle code is changed.
- `opaque-unknown` remains accepted as legacy input.
- The new `other` policy is fail-closed: `modelExposure=log-only`, no
  `surfaceOp`, no native `tool/result`.
- Raw native evidence remains Adapter-owned. Moving every historical inline
  `rawPayload` into a dereferenceable evidence vault is explicitly deferred.

## Focused breakpoints verified

1. Contract parser accepts MCSF `other` and fixes it to tool-card/log-only.
2. Unsupported Codex input becomes `other` with role `unknown`.
3. A malicious raw payload shaped as `user/message` is not replayed.
4. Alpha2 output has `maintenance/other`, `ignorable: true`, and no Surface
   operation.
5. Client projection accepts only explicitly log-only MCSF data.
6. Migration 011 preserves a legacy event and accepts a new `other` event.

## References

- `docs/superpowers/specs/2026-09-03-maintenance-canonical-session-format-v1.md`
- DeepSeek Harness `packages/core/session/src/types.ts`
- DeepSeek Harness `docs/subsystems/session.zh.md`
