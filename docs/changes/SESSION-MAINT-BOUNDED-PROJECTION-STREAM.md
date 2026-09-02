# Engine 0.1.7 / DSH plugin 0.2.3: bounded Alpha2 projection stream

## Problem

The legacy runtime snapshot endpoint assembled every projected session and all
events into one JSON object. A large catalog therefore forced both Engine and
the DSH client to retain the complete projection in memory before the first
session could be registered. The observed Alpha2 run contained 486 sessions
and roughly 1.1 million events; Node/V8 raised `Invalid string length`, the
endpoint returned HTTP 500 and Launcher appeared to remain stuck in startup.

## Projection catalog

Alpha2 projected sessions now retain the canonical session `updatedAt` value.
Projection Lifecycle writes a compact `session-catalog.json` sidecar after
materialization. Entries contain the native ID, canonical ordering timestamp,
event count, and the complete projected payload with `events: []`. The sidecar
is sorted by `updatedAt` descending with native ID as a deterministic tie-break.
Runtime session registration and append replacement update the sidecar
atomically.

## NDJSON APIs

- `GET /v1/projection-runs/:runId/runtime/stream?hotLimit=200`
- `GET /v1/projection-runs/:runId/runtime/sessions/:sessionId/stream`

The startup stream emits a schema-v2 `catalog-begin` boundary, one or more
bounded `catalog-sessions` chunks and a checked `catalog-end` boundary. The
entries mark at most the newest `hotLimit` sessions as hot. The stream then
emits only those hot sessions as ordered `session-begin`, `events`, and
`session-end` frames. A cold session is fetched through the single-session
endpoint without re-sending the catalog.

Alpha2 receives every catalog header, so its project list still shows cold
sessions. Only the newest 200 sessions receive physical event artifacts during
startup. Alpha2's SessionPersistence read boundary requests a cold session on
first access and waits for verified materialization before native history is
read. Mouse, keyboard, search, internal links and restored-current-session
navigation therefore share the same lazy-loading path.

Event frames target 512 KiB without splitting an event. One large event may use
its own frame up to an 8 MiB hard limit. Catalog chunks also target 512 KiB;
one pathological catalog entry may use its own frame up to an 8 MiB hard
limit. The stream never calls `JSON.stringify` on the complete event catalog or
on the complete lightweight directory.

## Verification breakpoints

- 201 sessions sort deterministically and exactly 200 are marked and emitted
  as hot.
- A metadata-only directory larger than 4 MiB is emitted as bounded catalog
  chunks without emitting any cold history.
- Hot and cold frame sequences reconstruct the original event arrays.
- Two 300 KiB events split into bounded frames; one 600 KiB event remains an
  allowed standalone frame.
- Unknown cold sessions return 404 before NDJSON headers are sent.
- A stale sidecar event count is rejected instead of silently truncating or
  duplicating a session.
- Two concurrent reads of one cold session produce one Maintenance request and
  both continue only after `lazy.materialize.commit`.
