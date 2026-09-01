# Alpha2 Runtime Broker event and durability lifecycle

## Scope

This change closes the in-process Maintenance-to-DSH runtime gap for the
Alpha2 public persistence seam. It does not start a real Launcher instance and
does not read, rewrite or delete a real DSH Home. All verification uses
synthetic run IDs, sessions and temporary projection directories.

## Runtime protocol

- `prepareRun` acquires the single-writer lease and materializes the canonical
  projection while the run remains in P1/P2 `preparing` state.
- The process client receives an opaque temporary persistence-root identity.
  Only the DSH plugin can acknowledge that identity and advance the run through
  P3 `attach`.
- Alpha2's official `session/event` listener synchronously enqueues the exact
  recorded event. A per-native-session promise chain prevents asynchronous
  HTTP completion from reordering consecutive appends.
- Engine records `runtime.event.received`, then the projection lifecycle records
  `runtime.wal.durable` and `runtime.canonical.committed` at their actual
  durability boundaries.
- Alpha2's awaited `session/flush` listener waits for the plugin queue and the
  Broker's per-session canonical pending set to reach zero. This listener runs
  in parallel with the official JSONL persistence listener; only the outer DSH
  flush proves that both sides completed.

## New native sessions

A session created after P3 is no longer ignored. Its first live event registers
the exact native `SessionHeader` and native session ID with the Broker before
append. The constructor seed does not emit `session/event`, so the first
operation carries the observed event prefix once. Later events carry only their
own event and preserve native sequence order, including after a transient
Broker failure.

The native header is preserved as runtime evidence. Its exact, normalized
`cwd` is resolved against canonical project roots and the new logical session
is assigned to that project after its first canonical commit. Canonical
workspace remains a separate Maintenance relation and is never inferred from
native `cwd`.

## Shutdown ownership

Plugin disposal performs the official DSH flush and sends a runtime `drain`
acknowledgement only. It never closes or removes the projection. A process
owner such as Launcher may call normal `closeRun` only after DSH terminates and
the Broker has received the drained acknowledgement. The close path then runs
the durability barrier, checkpoint, detach and temporary-root cleanup.

## Recovery boundary

The Engine WAL remains the authoritative retry source once an event reaches
the Broker. Recovery first replays that WAL, then the Alpha2 Adapter reads only
the Broker-created per-run official JSONL root. It validates the official path,
header, contiguous sequence and complete committed prefix before producing one
deterministic missing-tail operation. Rewrites, truncation, gaps, unknown files,
unmapped sessions and future formats fail closed and quarantine the run.

Broker ownership and runtime capability IDs are stored in the run recovery
descriptor. Therefore a restarted Engine can authenticate the owner, rebuild
the lifecycle context, recover a DSH-created session that had not yet reached
canonical storage, commit the JSONL tail, create a final checkpoint and remove
the temporary projection. Normal close remains separate and is rejected until
the plugin reports a completed runtime flush.

## Focused verification

- P3 cannot start with a mismatched temporary persistence-root identity.
- Normal owner close is rejected before the plugin's drained acknowledgement.
- Flush and drain wait for an outstanding canonical append.
- A DSH-created session is registered before its first live append.
- Two events observed while registration is pending remain ordered.
- A transient first append failure retries the same event, then commits the
  next event without replaying the full seed prefix.
- Plugin drain never invokes the owner-only close endpoint.
- Project-root matching assigns a newly created DSH session without changing
  its independent workspace relation; missing and ambiguous roots fail closed.
- Alpha2 tail recovery accepts an unchanged prefix and a contiguous tail, and
  rejects gaps, rewrites, unknown layouts and unmapped sessions.
- An abnormal owner close selects recovery even without a runtime-drained
  acknowledgement; normal owner close still cannot bypass that acknowledgement.
