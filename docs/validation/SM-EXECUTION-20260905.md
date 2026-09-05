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
| SM-03 | Implementing | Commands worktree based on `4162ecb`; GPT-6 Astra high |
| SM-04 | Implementing | Adapter worktree based on `4162ecb`; GPT-6 Astra high |
| SM-05 | Pending SM-03 | Coordinated import jobs |
| SM-06 | Pending SM-04/05 | Runtime/plugin internal responsibilities |
| SM-07 | SCM host committed and reviewed; Maintenance consumer pending SM-03/06 | SCM `e8ba84e` on exact installed `3833cb9`; 34 tests; separate repository |
| SM-08 | Read-only design complete; implementation pending SM-05 | Full reference inventory, external source coverage and writer coordination requirements documented by storage agent |
| SM-09 | Pending SM-06/08 | Runtime/cache/backup reclamation |
| SM-10 | Pending SM-07/08/09 | Five-day history retention |
| SM-11 | Pending SM-10 | Incremental index writes and measured benchmark |
| SM-12 | Conditional after SM-11 measurement | Chunking/compression/range reads |
| SM-13 | Pending independent Launcher review | Preserve five existing dirty files; separate repository commit |
| SM-14 | Per-batch integration in progress | Build identity, schema and lockfile digest added to archive/manifest; source batch 1 package verified; final versions and live release pending |

Current responsibilities: commands and adapters with GPT-6 Astra high; root
coordinates integration and packaged validation. Metadata work used xhigh;
SCM host and documentation used medium. No agent has written to a real runtime
home. The primary Maintenance checkout remains clean at `4b49927`.

The SCM host portion of SM-07 was completed early because it is independent of
the Engine services. The Maintenance consumer still waits for SM-03/06, so this
does not introduce a shared-file dependency race.
