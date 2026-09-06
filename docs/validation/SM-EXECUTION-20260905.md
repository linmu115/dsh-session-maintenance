# Session Maintenance execution status

Source baseline: `0333e18` -> `a6b4053` -> `4b49927`.
Integration branch: `codex/maintenance-refactor-integration-20260905`.

The original plan is `docs/superpowers/plans/2026-09-05-session-maintenance-refactor-implementation.md`.
The current selection is `docs/superpowers/plans/2026-09-06-maintenance-selected-refactors.md`,
based on the user's eight annotations and release baseline `0dbf921`.
This ledger distinguishes source completion, package verification, and live use.

| Task | Status | Evidence / next step |
| --- | --- | --- |
| SM-00 | Deployed; user UI acceptance pending | Engine 0.1.15; real Dashboard HTML, script and authentication verified |
| SM-01 | Integrated | Reviewed commit `7a37006`; 38 local links checked |
| SM-02 | Integrated | `4162ecb` from agent `d008942`; schema 17; 98 agent tests and 16 integration regression tests passed |
| SM-03 | Integrated | `e7c372a`; command/query services and exact identity transaction boundary |
| SM-04 | Integrated | `77736dd`; Store read ports and unified Adapter Registry |
| SM-05 | Integrated for 0.1.16 candidate | `fb48fbf`; coordinated import jobs, online/offline owner, cancellation/retry and bounded queue |
| SM-06 | Selected local extraction integrated | `4799d86`; run cache selection/refresh only; one runtime identity and state owner remains |
| SM-07 | Consumer integrated; host already live | Maintenance `159d92e`; SCM `0a98ea9` / 0.3.2; 34 host tests passed again |
| SM-08 | Integrated | `9cf5c64`, `f570185`; complete reference preview, unknown/external owner blockers and shared-body protection |
| SM-09 | Integrated | `a692fe1`, `f570185`, `323786f`; directory and flat SQLite governance, journal recovery and independent safety regressions |
| SM-10 | Outside this selected batch | Five-day history pruning remains disabled; all version bodies protected |
| SM-11 | Integrated independently of SM-10 | `5f7c855`; exact-prefix incremental index and 1,000/5,000-event benchmark |
| SM-12 | Outside this selected batch | Body chunking/compression/range-read migration not implemented |
| SM-13 | Separate source series committed; candidate built | `7b9dc67` then `47b2d5d`; Windows GNU actual tests/Clippy/release/replay passed; deployed Launcher preserved |
| SM-14 | Candidate validation | Engine 0.1.16 / plugin 0.2.18; build, typecheck and connected API tests passed; final full-suite/package evidence recorded with candidate handoff |

The earlier completed batch was committed and activated at the user's request;
production remains Engine 0.1.15 / Maintenance 0.2.17 / SCM 0.3.2. The new selected
batch resumes three agents: commands and Launcher use GPT-6 Astra high, storage
uses xhigh, and root owns composition, UI, integration and delivery. Independent
review regressions are retained in the final tree. All native/home fixtures are
synthetic; no actual isolation or deletion has run. User UI acceptance remains
manual. Primary Maintenance was verified clean at `0dbf921` during construction.

The original Launcher runtime-hook-seam worktree retains its five deployed
dirty files unchanged; its new source series is isolated and replayable. No
new candidate binary or package has replaced an installed component.
