# Alpha2 packed-event projection repair

Date: 2026-09-01

## Live failure breakpoint

Alpha2 completed the external lifecycle `prepare` phase, received the bounded
runtime catalog, and then failed while hydrating the first affected hot
session:

```text
append seq mismatch: expected 65 at index 65, got 85
```

The canonical event order and NDJSON transport were intact. The gap was caused
by Alpha2 JSONL storage rows such as `reasoning-chunks`: one physical row
losslessly represents a run of consecutive `assistant/chunk` events. The
canonical reseed retained that storage row, while the temporary native
projection treated it as one runtime event.

## Repair boundary

The Alpha2 adapter now expands packed storage rows only while materializing the
ephemeral native projection. It also decodes range-compressed
`sourceEventSeqs`. Canonical event rows are not rewritten, and the Launcher
lifecycle hook is unchanged.

## Focused verification

- Alpha2 adapter typecheck and build: passed.
- Packed-row and runtime-tail tests: 7 passed.
- Live canonical store scan: 486 sessions, 359 packed rows, zero sequence gaps
  after expansion.
- Full live projection: the failing session produced 961 events with native
  sequences `0..960`; no packed storage rows remained in the runtime payload.
