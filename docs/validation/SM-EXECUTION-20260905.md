# Session Maintenance execution status

Source baseline: `0333e18` -> `a6b4053` -> `4b49927`.
Integration branch: `codex/maintenance-refactor-integration-20260905`.

The approved plan is `docs/superpowers/plans/2026-09-05-session-maintenance-refactor-implementation.md`.
This ledger distinguishes source completion, package verification, and live use.

| Task | Status | Evidence / next step |
| --- | --- | --- |
| SM-00 | Source and portable package verified; live activation pending | 20 focused tests + 1 built UI test; full build; archive CLI/authentication/shutdown verification; `docs/changes/SM-00.md` |
| SM-01 | Integrated | Reviewed commit `7a37006`; 38 local links checked |
| SM-02 | Integrated | `4162ecb` from agent `d008942`; schema 17; 98 agent tests and 16 integration regression tests passed |
| SM-03 | Integrated | `e7c372a`; command/query services and exact identity transaction boundary |
| SM-04 | Integrated | `77736dd`; Store read ports and unified Adapter Registry |
| SM-05 | Paused outside release | Uncommitted import coordination work remains in its separate worktree |
| SM-06 | Pending SM-04/05 | Runtime/plugin internal responsibilities |
| SM-07 | SCM host committed and reviewed; Maintenance consumer pending SM-03/06 | SCM `e8ba84e` on exact installed `3833cb9`; 34 tests; separate repository |
| SM-08 | Read-only design complete; implementation pending SM-05 | Full reference inventory, external source coverage and writer coordination requirements documented by storage agent |
| SM-09 | Pending SM-06/08 | Runtime/cache/backup reclamation |
| SM-10 | Pending SM-07/08/09 | Five-day history retention |
| SM-11 | Pending SM-10 | Incremental index writes and measured benchmark |
| SM-12 | Conditional after SM-11 measurement | Chunking/compression/range reads |
| SM-13 | Paused outside release | Unverified hook changes remain isolated; deployed Launcher and its five prior dirty files are preserved |
| SM-14 | Current completed batch authorized for release | Engine 0.1.15, Maintenance 0.2.17, SCM 0.3.2; see release preparation and subsequent activation record |

Construction agents are paused at the user's request. The user explicitly
authorized committing and activating the completed batch, followed by their own
UI acceptance. Root performs release validation, backup and installation.
Commands and adapters used GPT-6 Astra high, metadata used xhigh, and SCM host
and documentation used medium. No unfinished worktree is part of this release.
The primary Maintenance checkout was verified clean at `4b49927` before release.

The SCM host portion of SM-07 was completed early because it is independent of
the Engine services. The Maintenance consumer still waits for SM-03/06, so this
does not introduce a shared-file dependency race.
