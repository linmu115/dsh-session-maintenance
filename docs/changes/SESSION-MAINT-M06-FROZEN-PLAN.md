# M06 follow-up — Freeze the reviewed import plan

## Live breakpoint and cause

The read-only preview succeeded against 331 current Codex conversations, but
the next stage observed a different plan digest. Codex was still running.
The original three-command protocol reread Codex both before staging and
during import, so a valid ongoing conversation could invalidate the reviewed
plan. Retrying or weakening the equality check is not a reliable fix.

## Change boundary

- Preview captures each normalized session in a new, exclusive snapshot
  directory next to the inactive candidate. Codex and the active Maintenance
  database remain read-only.
- A final manifest binds the source database/revision, selected Codex instance,
  source bindings, project assignments, descriptor order and every body hash.
- Stage consumes only this reviewed snapshot, checking the manifest and body
  hashes. It never reopens Codex. Current Maintenance state must still match
  the reviewed source digest before and after the SQLite backup.
- Incomplete or tampered snapshots cannot activate a candidate. Existing
  captures are not overwritten; partial artifacts remain for diagnosis.
- Later Codex changes are left for normal incremental synchronization. No
  session role mapping, Launcher hook, model, compaction, WAL receipt, native
  projection or Obsidian/annotation protocol is changed by this fix.

The old RC1 `turn 0 / step 0` recovery failure is a separate breakpoint. Its
run artifacts must be preserved and its runtime tail audited before activation;
this patch does not relax the new RC1 invariants or mark that run recovered.

## Focused checks

- Append to a synthetic Codex source after preview; stage the earlier snapshot
  successfully with a guard that throws if staging tries to reopen Codex.
- Verify the later Codex append remains untouched and is not silently included
  in the candidate.
- Reject changed manifest, changed body, missing capture and repeated capture.
- Retain the M06 checkpoint, old-head, derived-suffix and RC1 materialization
  checks.

## Verification result and remaining live boundary

Engine typecheck/build and all eight focused tests in the repair-plan,
topology-repair and Codex-import test files passed. A real frozen preview and
candidate import subsequently succeeded (331 selected mirrors, four new and
327 advanced). The active database was not changed or activated.

RC1 candidate validation then identified a separate pre-existing M04 boundary:
`collectPortableTurns` rejects a user message after model work inside the same
explicit source turn. A real Codex conversation contains exactly that valid
steering sequence before a turn abort. The candidate therefore remains
inactive. This patch does not delete/reorder that user message or relax the
guard. The RC1 representation of in-turn steering requires its own focused
mapping repair before the candidate may be accepted.
