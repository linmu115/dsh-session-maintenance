# RC1 persistent native session space

Engine 0.1.29 / plugin 0.2.23 / RC1 Adapter 0.1.5. Implements the user-approved
[specification](../superpowers/specs/2026-09-10-persistent-native-session-space.md)
from design commit `b0ef9af6a21627251d14e2c0ac8e97009e7da584`.

## Behavior

RC1 preparation now creates the complete native history under
`projection-runtime/native-spaces/<identity>/sessions`. Identity binds the
instance, profile, branch, Adapter and format. Subsequent launches reuse it;
normal close removes only the per-run control directory. Unchanged sessions
are checked by manifest digest and file identity without reading or encoding
their bodies during preparation. New, changed, deleted and relocated sessions
are reconciled before the host can start.

The RC1 Adapter owns physical header, seed, path and checksummed Zstandard
encoding. The lifecycle owns the stable directory, writer ownership, staged
replacement journal and checkpoint. The plugin consumes catalog metadata only,
seeds its existing title/tag/project indices, and records every history as
already native. It does not install the lazy hydration wrapper in this mode.
The Provider places launch patches in the separate run control directory.

The manifest stores digests, file identities, paths and run state, not bodies.
There are no per-launch full native backups. Unpublished staging is cleared
after ownership validation, and an interrupted published journal is completed
before launch. Unknown files, changed checkpoint identities and unfinished
owners are refused rather than overwritten. The existing JSON cache remains.

Runtime events retain the existing canonical commit and WAL path. Recovery
checks native tails even if the host exited before plugin attach. Native
checkpoint validation precedes shared-cache refresh, so an external Codex head
advance cannot replace the pinned run history during verification. Reusable
digests are then rebased on the refreshed cache without rewriting native files.

## Verification

All automated file tests use marked synthetic temporary directories. The
official RC1 compatibility check loads only library code from the selected
installation and reads only synthetic sessions:

```powershell
$env:DSH_OFFICIAL_ROOT = '<official RC1 installation>'
node scripts/verify-rc1-native-space.mjs
```

| Spec | Evidence |
| --- | --- |
| N01 | 205-session preparation test and official RC1 `list` / cold `readFrom` |
| N02 | Repeated prepare makes no body reads; unchanged bytes/mtime; metadata-only stream; plugin makes no create/append/materialization calls |
| N03 | Only the changed session is read and encoded |
| N04 | Delete, restore, cwd move and new-workspace registration across restart |
| N05 | Empty native file, title/tag/project index regression, official seeded-fork read |
| N06 | Normal append, duplicate operation retry, drain/close/reopen without duplicate tail or file rewrite |
| N07 | Engine restart recovers attached runtime's unsubmitted native tail |
| N08 | Interrupted replacement and failure between native manifest and catalog publication resume; orphan staging removed |
| N09 | Active owner, changed file identity and unknown file prevent replacement |
| N10 | Instance, profile and format identities produce isolated directories |
| N11 | Existing Alpha2 lifecycle and old descriptor regression; no changes to Alpha2 encoding |
| N12 | Native attach without explicit mode acknowledgement rejected; launch metadata is incompatible with the old plugin's strict field allowlist |
| N13 | Process writes a mapped tail before attach; restarted Engine recovers it before reuse |

Build and test commands, final counts, package digests and local deployment
details are recorded with the release acceptance evidence. User manual
acceptance is not represented as an automated result.

## Deployment and rollback

Use matching Engine and plugin builds. Stop the RC1 copy through its normal
lifecycle and finish retained runs before switching the Engine. Install the
plugin with the official DSH plugin command for the copy's `web` profile. Keep
the existing release available and preserve configuration rollback files.
Rollback requires a clean lifecycle close before returning to the old release;
an old Engine must not be used to dispose of a pending new-mode run.

ThoughtDAG adaptation and pluggable extension data are deferred. This change
does not add annotation/Obsidian snapshots or new extension backup policies.
