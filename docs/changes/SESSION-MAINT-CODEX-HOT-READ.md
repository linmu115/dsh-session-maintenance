# Codex live read and incremental import breakpoint

## Root cause

`CODEX_BUSY` is emitted by `adapter-codex-native` when Codex Desktop is running. It deliberately disables native writes, checkpoints and rollout replacement. It does not mean the read adapter or a Maintenance import must stop.

Codex `state_5.sqlite` uses WAL mode. A read-only SQLite transaction can therefore pin one catalog snapshot while Codex continues writing. Rollout JSONL files are not part of that SQLite transaction, so each requested rollout remains protected by the existing size and nanosecond-mtime checks before and after the body read. A changing rollout is reported as retryable and is skipped until the next incremental scan.

## Change

- Catalog and thread-row reads now use an explicit read-only SQLite transaction with `query_only` enabled.
- The adapter exposes structured `catalog.snapshot` and `rollout.stability` status breakpoints.
- Stable rollout reads report success; a changed catalog hint or rollout reports `retry` instead of interpreting partial content.
- No Codex database checkpoint, lock escalation, rollout write or native write capability is enabled.

## Focused regression

The regression switches the synthetic Codex database to WAL, holds an uncommitted writer transaction open, and proves that Maintenance can still list the prior consistent catalog snapshot and read a stable rollout. After commit, the next list observes the new title. The existing concurrent rollout mutation test also asserts the retry breakpoint.

## Operational meaning

Codex may remain open during read-only incremental synchronization. `CODEX_BUSY` should be presented as “native write unavailable; hot read/import available”, not as a migration failure. Any feature that intends to mutate Codex native storage must continue to require Codex to be fully closed.
