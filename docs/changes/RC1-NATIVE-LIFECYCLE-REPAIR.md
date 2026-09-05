# RC1 native lifecycle startup repair

## Exact failure

The 2026-09-05 RC1 startup reached `projection.delta-apply`, then failed
inspection with `assistant/chunk` naming turn 13/step 1 while no turn or
step was open. SQLite's experimental warning was incidental.

The retained Maintenance-native session `ls_170850e2e79e9699fa0b025e`
contained an old Alpha2 appended tail whose four boundary event types were
classified as MCSF `other`. The preceding native history and subsequent
chunks were retained, but boundary envelopes were stored only as evidence.
RC1 native append normalization had the same missing classification.

Official RC1 `@deepseek-ai/dsh-session` 0.1.2-rc.1 declarations
(`lib/types/types.d.ts`, `SessionEvents`) identify turn/start, turn/end,
step/start and step/end as control records. TurnEndReason is a tagged object,
not a string. These records are not user or assistant messages.

## Boundaries

- RC1 0.1.2 keeps known native controls as system-metadata with exact envelopes.
- Portable append behavior and unknown-event isolation are unchanged. The
  projector still refuses to replay an arbitrary `other` envelope.
- The Alpha2 module adds an **offline-only** evidence restoration helper, not
  a runtime compatibility branch. Only its four exact boundary types qualify;
  adapter, format, source type, sequence, provenance, data and absence of a
  model surface operation must match. Missing or mismatched evidence fails.
- The explicit repair script defaults to read-only preview. Apply requires
  a reviewed head ID, an active Maintenance-native session and zero active
  projection writers. It creates a database backup and Checkpoint, then
  commits a new child version. IDs, messages, metadata, old version and
  evidence are retained. Codex mirrors/derivations are not repair targets.
- Candidate acceptance now inspects the whole active catalog, including
  retained native sessions, rather than only the migrated Codex subset.
- Inspection reports the logical session and failing event sequence.
- No Launcher, Profile plugin, model, compaction or Codex source changes.

## Focused checks

- 61 tests in 12 focused files passed, including the full RC1 Adapter suite,
  candidate repair scenarios and the existing Engine reference endpoint.
- Engine/Adapter builds, script syntax and `git diff --check` passed.
- Native append -> project -> append -> project keeps exact event envelopes.
- Portable controls remain evidence-only; unknown native data stays isolated.
- Exact historical boundary restoration retains IDs and messages; missing or
  mismatched evidence fails. Existing other-isolation tests remain enabled.
- Whole-catalog read-only preview: 338 sessions passed RC1 inspect/verify,
  including six Maintenance-native sessions.
- Target preview restores only six control records, sequences
  1762, 1764, 1901, 1902, 1965 and 1966. The 1,149 Canonical rows still expand
  to the same 1,967 native event positions (packed chunks explain the counts).

Manual acceptance: start existing RC1 web from Launcher, inspect the old
native conversation, then send one message. Stop/start again to verify its
new control events survive the durable append/reload path. Do not claim this
manual acceptance on the basis of synthetic tests alone.

## Applied locally

- Active database remains `metadata.conversation-repair-20260905-r4.sqlite`.
- Only target head advanced: `sv_39edddaa7810e428b3f7d66f` ->
  `sv_59c119eb3cf135de904ad875`. All 1,149 event IDs retained; original version
  re-read after commit and verified byte-equivalent at the event level.
- Checkpoint: `checkpoint-native-lifecycle-d607c87f-dc2b-446f-a80a-02913000547b`.
- Full database backup under Maintenance `backups/`:
  `pre-native-lifecycle-5e7c7756-9f1f-47bc-b6b2-93227396b585.sqlite`.
- Post-commit preview is idempotent (zero further repairs) and RC1 inspection
  passes. Maintenance Engine was reloaded, health returned ready and its
  registry reports Adapter 0.1.2. Launcher and DSH were not started by this
  repair. RC1 Profile plugin remains 0.2.15; no Profile reinstall is required.

## User acceptance

On 2026-09-05 the user reported that actual usage no longer had problems and
authorized committing and pushing this version. This is user-performed
acceptance, separate from the synthetic and read-only checks above.
