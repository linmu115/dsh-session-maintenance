# Changelog

## 0.2.12 - 2026-09-02

- Advance each live session's in-memory logical ID and base version from the
  durable append receipt. Consecutive Alpha2 events no longer reuse the
  startup catalog's stale base and fail with `NATIVE_REVISION_MISMATCH` or
  `APPEND_COMMIT_FAILED` after the first successful write.
- During crash recovery, supersede an already-projected WAL operation whose
  logical/base metadata predates the last durable receipt, log the decision at
  `recovery-stale-metadata-superseded`, and reconstruct the native tail against
  the current mapping. The same check now runs for both an in-memory stopped
  run and a run restored after an Engine restart.
- Remove Codex-only goal, embedded-browser and response-annotation scaffolding
  from projected user turns, including Codex's `<environment_context>` date,
  timezone, workspace and permission block. User-visible delegated tasks
  retain only their actual `<input>` content.
- Inherit the parent catalog project's membership when the first DSH write
  derives a Maintenance-owned child from a Codex mirror.
- Reconstruct Alpha2's unreported `session/end-seed` boundary from the live
  event prefix when a projected session resumes. Permission, sandbox and
  approval preparation events are held until a real continuation arrives, so
  opening a Codex mirror neither fails native-revision validation nor creates
  a spurious DSH branch.
- Apply the same continuation boundary during crash-tail recovery. Runs left
  by an older plugin with preparation-only tails can now be recovered and
  release their lease without manufacturing a DSH-derived session. Pending
  preparation-only WAL records are retained as superseded artifacts and emit
  an explicit `recovery-prelude-superseded` status breakpoint.
- Keep Codex worktree startup diagnostics out of catalog titles. When Codex's
  fallback title appends `[info]`, `[stderr]` or `fatal:` rows to the user's
  first-line question, only that question is projected into DSH.
- Let shutdown recovery discard Alpha2's untouched composer shell when it has
  only automatic permission, sandbox and approval preparation, without
  creating a blank Maintenance-native session. Any real event still fails
  closed.

## 0.2.11 - 2026-09-02

- Rebuild the mutable latest-event index whenever a new immutable canonical
  head is committed. Adapter normalization upgrades can now convert historical
  Codex tool records without colliding with the old sequence rows; prior
  version bodies remain readable from the content-addressed object store.
- Read projection events from the exact immutable head body. DSH continuations
  now include their frozen Codex base plus the DSH tail instead of beginning at
  a non-zero sequence or borrowing a newer parent head.
- Recover an Alpha2-created session whose empty registration reached the
  temporary projection before the canonical mapping transaction completed.
  Registration is idempotent, receives project membership immediately and is
  finalized through the same durable tail-recovery path after a crash.
- Treat finalization as a bounded large-projection operation and retain nested
  recovery causes in status logs. A valid multi-hundred-megabyte projection no
  longer fails merely because the former 15-second HTTP timeout elapsed.
- Prefer Codex's explicit task name, then strip attachment, embedded-browser
  and DSH-continuation wrappers from unnamed fallback titles. This changes only
  sidebar metadata, never the Codex authoritative transcript.
## 0.2.10 - 2026-09-02

- Filter Codex Guardian approval threads and spawned worker threads at the
  catalog boundary while retaining user-visible root and VS Code delegation
  tasks. Existing internal mirrors can be recoverably hidden behind one
  Maintenance Checkpoint without changing the Codex source database.
- Stop deriving titles from approval transcripts. Codex task names now remain
  authoritative, so tool payloads and delegation protocols cannot become DSH
  conversation titles.
- Convert Codex `custom_tool_call`, `function_call` and their outputs into
  canonical tool-call/tool-result events, then materialize Alpha2's native
  `tool/call` and `tool/result` envelopes instead of user message bubbles.
- Capture active Codex rollouts through an append-safe bounded prefix. Hot
  imports no longer fail merely because Codex appended after the catalog
  snapshot; replacement or truncation still fails closed.
- Add per-session reseed status breakpoints and stream SHA-256 candidate files,
  allowing verified canonical stores larger than 2 GiB without one-shot V8
  buffers.

## 0.2.9 - 2026-09-01

- Expose every Maintenance catalog header through Alpha2's public
  `SessionPersistence.list()` boundary. Cold sessions now remain visible in
  their project folders without preloading their event histories; selecting
  one still hydrates it through the bounded per-session stream.
- Materialize imported Codex user and assistant turns as fully identified
  Alpha2 messages with stable IDs, roles, sources and content blocks. This
  repairs sessions that previously appeared in the sidebar but failed replay
  with `lacks an identified message`.
- Seed concise Codex task names from the Codex catalog before preparing a run,
  replacing raw prompt, delegation and approval-transcript titles without
  changing conversation events or last-active ordering.
- Preserve foreign canonical tool records as ignorable Maintenance envelopes
  when they cannot satisfy Alpha2's native tool-call correlation contract.

## 0.2.8 - 2026-09-01

- Generate Alpha2 projection session IDs with a deterministic Base64URL suffix
  instead of the former `dsh-maintenance:` prefix. The resulting native IDs
  satisfy Alpha2's per-record storage key contract, so title/list projection
  checkpoints can be created and later updated by the official cache service.
- Reject a projection catalog with a non-path-safe native session ID at the
  runtime boundary, before Alpha2 begins mutating its session or cache stores.

## 0.2.7 - 2026-09-01

- Make interrupted Alpha2 tail recovery idempotent only when the already-written
  native event suffix exactly matches the pending recovery operation. This
  repairs a projection that was advanced before a status-log failure without
  accepting a genuinely divergent equal-revision history.
- Record Alpha2 native revisions after packed canonical rows are expanded,
  instead of using the smaller canonical storage-row count. The public Adapter
  contract can now derive and validate a canonical native prefix revision;
  recovery upgrades old mappings and preserves any real runtime tail.
- Expand the runtime status-event schema for the Alpha2 lifecycle durability
  breakpoints, preserving existing diagnostic rows during the migration.
- Place run-scoped project cwd projections beside the native session root so
  Alpha2 recovery never mistakes project directories for session artifacts.

## 0.2.6 - 2026-09-01

- Call Alpha2's function-valued `appExit` service directly from the run-scoped
  graceful-shutdown endpoint. The former object-style call returned HTTP 202
  and then crashed while reloading, leaving Launcher recovery-required.
- Normalize Alpha2's default `delegationDepth: 0` across materialization and
  recovery, and treat intentionally unmaterialized lazy sessions as having no
  runtime tail. This lets a bounded 200-hot-session run recover without
  misclassifying its cold catalog entries as deleted logs.

## 0.2.5 - 2026-09-01

- Restore Alpha2 project grouping after the external projection attaches by
  rebuilding public Workspace Registry records from canonical project roots.
  Projects without a usable native root receive a run-scoped managed cwd, so
  DSH can validate membership without making its workspace IDs canonical.
- Seed Alpha2's native `title` and `sessionListMetadata` projection checkpoints
  from Maintenance metadata. Session rows now keep their actual conversation
  titles instead of falling back to the project/cwd label, without synthesizing
  events or changing canonical history.
- Reconcile and prune stale Workspace Registry membership through public APIs,
  remove obsolete Maintenance-managed workspaces from earlier temporary runs,
  and map live DSH continuations in managed cwd paths back to their canonical
  project IDs.
- Add `runtime.workspace.index`, `runtime.workspace.reconcile` and
  `runtime.projection-cache.seed` startup breakpoints with counts and the first
  workspace failure for focused diagnosis.

## 0.2.4 - 2026-09-01

- Expand Alpha2 `text-chunks`, `reasoning-chunks` and `tool-call-chunks`
  storage rows back into their exact `assistant/chunk` events when building a
  temporary native projection. The first live 0.2.3 launch exposed that the
  canonical reseed retained these lossless packed rows while Alpha2's
  persistence API requires every runtime `seq` to be contiguous.
- Decode range-compressed `sourceEventSeqs` before handing projected events to
  Alpha2, preserving answer/source provenance and replacement-surface
  semantics without rewriting the Maintenance canonical store.
- Add a focused packed-row regression and validate the live 486-session store:
  359 packed records expand with no remaining sequence gaps; the previously
  failing session now materializes 961 contiguous native events.

## 0.2.3 - 2026-09-01

- Segment the lightweight startup directory into bounded schema-v2
  `catalog-begin`, `catalog-sessions` and `catalog-end` frames. The first live
  0.2.2 launch proved that 486 metadata-only session entries can themselves
  exceed 4 MiB even when event histories are streamed separately; the old
  single catalog frame therefore still aborted Alpha2 during plugin loading.
- Keep each catalog chunk near 512 KiB and validate the declared entry count at
  both boundaries before registering the directory. This preserves all cold
  session buttons while avoiding one oversized V8/HTTP line.
- Add a regression fixture whose metadata-only catalog exceeds 4 MiB and prove
  that it is transferred in bounded chunks without loading any cold history.

## 0.2.2 - 2026-09-01

- Replace the monolithic Alpha2 runtime snapshot with an incremental NDJSON
  stream. Event frames target 512 KiB, so startup no longer constructs one V8
  string containing the complete multi-session event catalog.
- Sort the lightweight session catalog by canonical `updatedAt` and materialize
  only the newest 200 sessions during startup. Older sessions retain native
  header entries in the DSH project list without loading their event history.
- Hydrate a cold session through its dedicated Maintenance stream when Alpha2
  first reads it. Concurrent reads share one request, and native history access
  is released only after the complete event count has been verified.
- Add `lazy.catalog.ready`, `lazy.borrow.request`,
  `lazy.materialize.commit` and `lazy.materialize.failed` status-log breakpoints
  for focused startup and cold-session diagnosis.
- Surface the Engine error body to the plugin instead of reducing runtime
  stream failures to an HTTP status code.

## 0.2.1 - 2026-09-01

- Separate logical projects from execution workspaces. Project roots are
  projected to Alpha2 `SessionHeader.cwd`, while the canonical workspace/cwd is
  preserved independently and is never reconstructed from the projection.
- Add read-only Codex WAL snapshots and direct canonical hot import. Unchanged
  Codex sessions remain no-ops; a DSH continuation becomes a derived branch
  only after Alpha2 records a new session event.
- Add a verified Alpha2 reseed command that builds a new candidate database,
  preserves selected DSH/Obsidian test sessions with their complete raw event
  envelopes, imports the live Codex catalog, checks project/workspace
  memberships and refuses activation on any integrity or count mismatch.
- Group the standalone WebUI by project and render canonical conversations as
  inert, sanitized Markdown without executing raw HTML or active resources.
- Add the client-neutral Runtime Broker `prepare`, `attach`, `append`, `flush`,
  `drain` and owner-only `close` protocol for Alpha2 temporary projections.
- Observe Alpha2's public `session/event` and `session/flush` hooks with ordered
  per-session retry queues and explicit WAL/canonical durability status logs.
- Register sessions created during an active DSH run from their exact native
  header before committing the first live event.
- Require a plugin runtime-drained acknowledgement before normal process-owner
  close, checkpoint and temporary projection cleanup.
- Accept the complete Runtime Broker launch handoff, including owner/runtime
  client IDs, run ID, temporary persistence-root ID and DSH version. The old
  0.2.0 artifact rejected these fields before Alpha2 could attach.
- Consume the projection overlay through the external lifecycle provider's
  launcher-argument channel so `--patch` is parsed by DSH rather than the Web
  profile application.

## 0.2.0 - 2026-08-31

- Replace per-instance native mirror ownership with a Maintenance canonical session store and stable logical workspaces.
- Add temporary Alpha2 and RC2 projections, runtime append commit, clean shutdown, WAL recovery and single-writer leases.
- Preserve Codex as an independent authority; identical observations are no-ops and first DSH continuation creates one derived session.
- Add public Adapter SDK, isolated Adapter Host, Alpha2 and RC2 adapters, experimental selection and compatibility reports.
- Resolve Annotation, Sticker and Obsidian links through logical session and anchor IDs while retaining historical aliases.
- Add the standalone canonical WebUI for static browsing, lineage, move, delete, restore, Checkpoint and P1-P8 diagnostics.
- Add Launcher maintenance-backed Profile metadata without storing permanent session directories.

The Alpha2 and RC2 end-to-end manual chain remains a user acceptance gate before this Generation is registered as stable.
