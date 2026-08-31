# T06 — Persistent diagnostic status spans

## Scope

This task adds the reusable StatusLog module and Engine query/SSE surfaces for
the fixed P1-P8 stages. It establishes the required state-log entry point but
does not yet claim that projection lifecycle stages have run; later lifecycle
tasks will emit those stages around real operations.

## Changes

- Added the `@linmu/dsh-session-status-log` workspace package.
- Added one `StatusEventAdapter` interface with in-memory and SQLite
  implementations, exercised by the same parameterized tests.
- Added `start`, `succeed`, `fail`, `list`, and `subscribe` operations.
- Terminal events always retain the started event's span ID and point to the
  started event through `parentEventId`.
- SQLite events are persisted before they are published, so SSE subscribers see
  the same event that the query endpoint returns.
- Added Engine endpoints:
  - `GET /v1/status-events` for filtered persistent queries;
  - `GET /v1/status-events/stream` for authenticated live SSE.
- Added filters for run, logical session, operation, stable stage, and span.
- Restricted persistent diagnostic input:
  - no raw detail, body, prompt, or token fields exist in the event contract;
  - `diagnosticDetailRef` accepts only bounded opaque `diag:` or `object:` IDs;
  - `errorCode` accepts only bounded machine identifiers;
  - a terminal event cannot be emitted without a started-event handle.
- Suppressed duplicate live publication when an idempotent SQLite event append
  is replayed.

## Focused verification

Commands:

    pnpm exec vitest run packages/session-status-log/test/status-log.test.ts apps/engine/test/status-events.test.ts
    pnpm --filter @linmu/dsh-session-status-log typecheck
    pnpm --filter @linmu/dsh-session-maintenance-engine typecheck

Results:

- 2 test files and 5 tests passed.
- Both modified packages passed typecheck.
- Memory and SQLite adapters produced the same started/succeeded/failed pairs.
- Live subscription received the exact event later returned by the durable HTTP
  query.
- Prompt, token, and body-shaped extra properties did not enter serialized
  events.
- Raw diagnostic references and prose-shaped error codes were rejected.

## Breakpoint policy

The initial adapter, persistence, and SSE breakpoints passed. Self-review found
two narrow redaction risks (`errorCode` prose and path-shaped detail refs); both
were tightened inside the existing redaction breakpoint. No unrelated status
matrix or synthetic P1-P8 success event was added.

## Safety

- SQLite verification used marked temporary databases and the Engine fixture
  sandbox.
- No real Codex or DSH home, active projection, Launcher Profile, or Generation
  was read or written.
- SSE contains only the same redacted structured record already persisted.
