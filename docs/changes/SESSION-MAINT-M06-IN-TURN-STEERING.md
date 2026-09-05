# M06 follow-up — Preserve user steering within an RC1 turn

## Located failure

The reviewed candidate contained a genuine Codex user correction after model
and tool work inside the same explicit turn. The RC1 materializer rejected any
such position. Independently, the shared topology planner reset a partially
specified source turn to step zero whenever a user message appeared.

## Official RC1 contract checked

Exact installed official npm packages at `0.1.2-rc.1` were inspected:

- `dsh-agent-loop/lib/index.js:539-577`: the loop starts its next step and
  appends claimed user input before running the model. A next-step inbox can
  keep the same turn alive after a prior model response.
- `dsh-session/lib/types/invariant.js:79-107`: model work requires an open
  matching step; `user/message` has no before-model position restriction.
  Tool results still need a preceding call within the matching step.
- `dsh-client-ui-chat/lib/client.js:4463-4502`: one assistant node is keyed by
  turn/step. Multiple independent assistant messages within that step overwrite
  the earlier displayed content. Storage validity alone does not prove UI
  preservation.
- `dsh-session/lib/types/surface.js:85-98`: surface messages retain event order.
  Native storage validity does not guarantee provider request validity for a
  user message inserted between a tool call and its result.

## Changes and limits

- For source turns without explicit step coordinates, steering after model
  work advances the current step. It never resets the turn to step zero.
- Consecutive user corrections do not create multiple empty model steps.
- Outstanding parallel calls remain together with their results; a user
  correction does not split their correlation coordinates.
- RC1 materialization preserves user encounter positions, including a final
  correction before an aborted source turn, rather than rejecting or moving
  them to the start of the turn.
- An explicit step containing assistant content on both sides of a user is
  rejected at that narrower boundary. It is neither silently reordered nor
  emitted as competing assistant nodes in the same RC1 step.
- Canonical event IDs, contents, sequence and source provenance are unchanged.
  Fully explicit step coordinates and native DSH envelopes are not rewritten.
- No Codex file, active Maintenance database, Launcher/profile configuration,
  official compression setting, receipt or reference protocol is modified.

## Focused verification

31 tests passed across the topology planner, RC1 tool projection, RC1 smoke
and projection revision, frozen import plan, synthetic candidate migration and
Codex canonical import. Domain, RC1 Adapter and Engine typechecks/builds passed.

Read-only preflight then consumed the already reviewed, hash-checked snapshot,
one session at a time, through Canonical planning, RC1 materialization and
inspection. It created no database and never reread the moving Codex source:

- 331 sessions; 41,733 canonical events; 68 sessions contain in-turn steering.
- 317 sessions passed the native projection checks.
- 14 sessions failed at an independent noncontiguous source-turn boundary.
- Across the snapshot, 522 call/result pairs have conflicting assigned source
  turns; 521 of the 522 returns to an earlier turn are tool-result events, and
  the remaining return is a user-message event. These are diagnostics, not
  permission to discard those records.
- One otherwise native-valid session contains an internally generated tool-use
  warning misclassified as a user message between a call and its result. This
  is not evidence of provider-request readiness.
- Sampled progress resident memory was approximately 199–247 MiB. This is not
  a measured peak. No additional multi-gigabyte candidate database was built.

## Remaining breakpoints — not changed by this commit

### Codex turn identity precedence

`adapter-codex-read/src/normalizer.ts`, `responseItemTurnId` / `assignTopology`,
prefers `internal_chat_message_metadata_passthrough.turn_id` over the active
`task_started` / `turn_context` turn. A targeted read-only raw-log check found
the call and result with the same exact `call_id` had different embedded turn
IDs while the enclosing task turn had not changed. The adapter consequently
split a valid tool pair across turns. The enclosing task and response metadata
must not be treated as interchangeable coordinates without a source contract.

### Internal warning classification

The frozen sample's `Warning: apply_patch was requested via shell...` was
classified as `user-message`, despite being a generated operational warning.
This needs a source-scoped classification fix, not deletion of actual user
steering or provider-side history reordering.

### Deleted children and fork protection

The migration currently considers 11 derived children whose parents are
selected, but 10 are already tombstoned. `loadSessions` intentionally excludes
them; adding them to RC1 verification therefore cannot succeed. Deleted heads,
tombstones and lineage must be retained without active recomposition.

The only active child's frozen replacement prefix was checked separately:
all 302 source IDs occur in order within its old 521-event fork base, its source
fingerprint still matches that base, and all 109 DSH suffix events are retained.
No post-fork Codex advancement was found for this child. Nevertheless, the
general migration must explicitly prove this bound instead of blindly taking
an arbitrary latest parent head.

## Deployment state

The active database remains `metadata.alpha2-stable3-20260901.sqlite`, revision
25340, with no active projection writer at the final read-only check. The
previous failed candidate, frozen plan, old versions and quarantined run remain
untouched. No candidate was activated, no Profile was deployed, and no running
process was restarted. This local fix is not a declaration of migration
completion; the remaining source/migration boundaries must pass first.
