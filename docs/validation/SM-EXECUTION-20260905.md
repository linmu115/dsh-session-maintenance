# Session Maintenance execution status

Source baseline: `0333e18` -> `a6b4053` -> `4b49927`.
Integration branch: `codex/maintenance-refactor-integration-20260905`.

The original plan is `docs/superpowers/plans/2026-09-05-session-maintenance-refactor-implementation.md`.
The current selection is `docs/superpowers/plans/2026-09-06-maintenance-selected-refactors.md`,
based on the user's eight annotations and release baseline `0dbf921`.
This ledger distinguishes source completion, package verification, and live use.

Plugin hotfix activated on RC1: **Maintenance 0.2.19**, source `7ab31ac`; settings
and sidebar global Dashboard navigation no longer depends on session mapping.
Engine 0.1.16 and SCM 0.3.2 remain in use. See
[the hotfix record](2026-09-06-maintenance-0.2.19-dashboard-hotfix.md).

| Task | Status | Evidence / next step |
| --- | --- | --- |
| SM-00 | Deployed; user UI acceptance pending | Engine 0.1.16; actual RC1 plugin Dashboard launch, HTML, script and authentication verified |
| SM-01 | Integrated | Reviewed commit `7a37006`; 38 local links checked |
| SM-02 | Integrated | `4162ecb` from agent `d008942`; schema 17; 98 agent tests and 16 integration regression tests passed |
| SM-03 | Integrated | `e7c372a`; command/query services and exact identity transaction boundary |
| SM-04 | Integrated | `77736dd`; Store read ports and unified Adapter Registry |
| SM-05 | Deployed | `fb48fbf`; coordinated jobs/owner/cancel/retry; `04988c6` shared connection contract; `0ff6081` completes startup recovery before readiness |
| SM-06 | Selected local extraction deployed | `4799d86`; run cache selection/refresh only; one runtime identity and state owner remains |
| SM-07 | Consumer and host deployed | Maintenance `159d92e` / 0.2.18; SCM `0a98ea9` / 0.3.2; 34 host tests passed |
| SM-08 | Deployed; live read-only preview verified | `9cf5c64`, `f570185`; complete reference preview, unknown/external owner blockers and shared-body protection |
| SM-09 | Deployed; no real reclamation executed | `a692fe1`, `f570185`, `323786f`, `a39f7e7`, `f2b3c16`; directory/flat governance, journal recovery, independent regressions, rebuilt cache identity and verified refresh ordering |
| SM-10 | Outside this selected batch | Five-day history pruning remains disabled; all version bodies protected |
| SM-11 | Deployed independently of SM-10 | `5f7c855`; exact-prefix incremental index and 1,000/5,000-event benchmark |
| SM-12 | Outside this selected batch | Body chunking/compression/range-read migration not implemented |
| SM-13 | Separate series deployed | `7b9dc67` then `47b2d5d`; Windows GNU tests/Clippy/release/replay passed; real Launcher cold-started RC1 with the final Engine |
| SM-14 | Activated; user UI acceptance pending | Engine 0.1.16 / plugin 0.2.18; final 174 files / 564 tests passed, build/typecheck passed, 29 archive entries checked, live Dashboard launch authenticated, schema 17 -> 20 migration invariants preserved |

At the user's deployment request, DSH 0.1.2-rc.1 / web now uses Engine 0.1.16,
Maintenance 0.2.18, SCM 0.3.2, and Launcher source `47b2d5d`. The selected work
used GPT-6 Astra agents with high/xhigh reasoning and root integration. All test
fixtures are synthetic; deployment used the actual target with a separate
database and a complete rollback snapshot. No real isolation or deletion ran.
User UI acceptance remains manual.

The original Launcher runtime-hook-seam worktree retains its five local files;
the installed replacement is from a separate committed and replayable series.
Old binary, plugin, state, objects, runtime evidence and configuration are retained.

Final active package source is `0ff6081c9b888da1919acbec98849c2f68470ae2`, clean
at packaging. Its tracked tree exactly matches the final agent full-suite tree.
The earlier `f2b3c16` candidate is retained as superseded evidence. Deployment
preserved the old schema 17 database and migrated a separate file to schema 20;
all seven stable business/history metadata digests remained identical.
See [the activation record](2026-09-06-maintenance-0.1.16-activation.md) for
active package identities, validation logs, rollback and manual acceptance.
