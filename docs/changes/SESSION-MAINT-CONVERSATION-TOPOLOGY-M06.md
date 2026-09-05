# M06 — Controlled RC1 Conversation-topology Repair

## Outcome

M06 can rebuild Codex mirrors and their DSH-derived conversations into the
typed MCSF conversation topology introduced by M01-M05. It is an explicit,
three-command maintenance operation:

1. preview a stable, read-only Codex import plan;
2. stage and verify a new Maintenance database candidate; and
3. activate that exact candidate only after the operator reviews its digests.

The repair is never run by Launcher startup, DSH startup, projection attach or
normal Codex synchronization.

## Why a candidate rebuild is required

Old active heads may contain records imported before the Codex Read Adapter
owned role, turn, step and tool-pairing classification. Some DSH-derived heads
also contain a frozen Codex prefix followed by native RC1 events. Rewriting
those rows in place would destroy the old evidence and blur the authority
boundary.

The staged candidate therefore:

- imports every current Codex mirror again from the read-only Codex source;
- creates new immutable Session Versions and preserves the old versions;
- retires mirrors no longer present in the current Codex catalog in the
  candidate only;
- recomposes each affected derived conversation as the corrected Codex prefix
  plus its existing DSH-owned suffix;
- converts that retained suffix to portable MCSF semantics before replanning
  its conversation topology; and
- preserves logical session IDs, immutable old versions and retained source
  identities. Re-normalized event IDs and content digests may change; external
  anchor stability is a separate acceptance requirement, not a consequence of
  successful RC1 schema validation. See the measured boundary in
  [M06-CODEX-TURN-IMPORT-REPAIR.md](M06-CODEX-TURN-IMPORT-REPAIR.md).

The derivation row remains the immutable historical fork point. The new child
head records both the former child head and the refreshed parent head as its
parents.

## Bounded read and write path

Codex planning and candidate import are streamed one normalized session at a
time. Preview writes an exclusive, inactive `.conversation-plan` directory
next to the candidate path, with one digest-named body file per session and a
manifest written last. The plan retained in memory contains only lightweight
descriptors and digests, not every event body. The reviewed plan digest binds
the complete session bodies, source binding, assignments and source database
revision. Staging verifies this frozen manifest and each body instead of
reopening a moving Codex source. New Codex events remain available to normal
incremental synchronization after migration; staging does not overwrite them.

Codex classification totals remain Adapter-local process diagnostics. They
are not fields in the shared `NormalizedSession` DTO and are never serialized
into discovery/version objects; only the typed semantics attached to each
normalized event cross the Adapter boundary.

Candidate RC1 validation also loads, materializes, inspects and releases one
session at a time. This keeps memory proportional to the largest affected
session rather than to the complete Codex catalog.

Projected RC1 sessions declare whether their Canonical history is `native` or
`portable`. The Runtime Broker carries that mode through every durable append.
Only portable histories are replanned with MCSF topology after a live append;
native DSH histories retain their Harness envelope unchanged.

## Operator workflow

Run the commands only while all projection runs are closed. Use a fresh
candidate filename for every attempt.

```text
dsh-session-maint canonical repair-rc1-preview \
  --candidate-file metadata.conversation-repair.sqlite \
  --codex-instance <instance-id> --json

dsh-session-maint canonical repair-rc1-stage \
  --candidate-file metadata.conversation-repair.sqlite \
  --codex-instance <instance-id> \
  --source-digest <preview-source-digest> \
  --codex-plan-digest <preview-plan-digest> --json

dsh-session-maint canonical repair-rc1-activate \
  --candidate-file metadata.conversation-repair.sqlite \
  --source-digest <preview-source-digest> \
  --candidate-digest <staged-candidate-digest> --json
```

Preview does not create a candidate database or modify either source, but it
does persist the reviewed import-plan snapshot. Use a fresh candidate filename
after an incomplete capture; existing snapshots are never overwritten.
Stage creates a new SQLite candidate,
a pre-repair Checkpoint and a sidecar manifest. A failed candidate remains
inactive for diagnosis. Activation rechecks the source digest, candidate
digest, SQLite integrity, foreign keys and absence of an active projection
run before switching the configured database pointer. The previous database
file remains available for rollback, and an Engine restart is required.

## Status breakpoints

The coarse status stream is deliberately small:

| Breakpoint | Meaning |
| --- | --- |
| `repair.preview` | Source boundary, empty target and summary are valid. |
| `repair.codex-plan` | A stable read-only Codex plan and digest exist. |
| `repair.checkpoint` | Every previous candidate session head is recorded. |
| `repair.mirror-write` | Refreshed mirrors and candidate-only retirements are committed. |
| `repair.derived-recompose` | Corrected prefixes and retained DSH suffixes are joined. |
| `repair.rc1-verify` | Every affected head passes the actual RC1 materializer and inspector. |
| `repair.candidate-ready` | Integrity checks, digest and manifest are complete. |

A failure is recorded at its exact breakpoint. Finer diagnostics should be
added only inside the failed interval.

## Safety boundary

- Codex is opened through the read-only catalog/rollout adapter only.
- No Codex rollout, index, SQLite, WAL or SHM file can be written.
- The active Maintenance database is opened read-only during preview and
  copied with SQLite online backup during stage.
- No existing Canonical event, Session Version or evidence object is edited or
  deleted.
- No Launcher, profile, model, compaction or plugin protocol is changed.
- Project, workspace, deletion and runtime lifecycle behavior is not changed;
  only the inactive candidate receives migration metadata.
- No raw unknown record is widened onto the user, assistant or tool-result
  model surface, and no missing tool result is manufactured.

## Focused verification

Synthetic acceptance covers a refreshed Codex mirror, an obsolete internal
mirror, and a derived conversation with a mixed native RC1 suffix. It verifies
that preview is read-only, staging preserves old heads and versions, the
candidate retires only the obsolete mirror, the derived suffix survives as
portable events, RC1 validation passes, activation switches only the supplied
pointer, and the complete synthetic Codex Home digest is unchanged.

The live-source follow-up verifies that Codex may append after preview while
staging still consumes exactly the approved snapshot without opening Codex.
Tampered manifests, tampered bodies, absent snapshots and duplicate capture
targets are rejected. Codex data written after the preview remains unchanged.
