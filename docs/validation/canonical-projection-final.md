# Canonical Projection Final Validation

## Status

Automated verification and candidate Generation packaging completed on 2026-09-01. Manual UI acceptance is intentionally reserved for the user; the candidate is not registered as stable and no repository has been pushed.

## Fixed breakpoint gate

| Breakpoint | Stage | Result |
| --- | --- | --- |
| P1 | `run.lease` | automated pass; live pending |
| P2 | `projection.materialize` | automated pass; live pending |
| P3 | `runtime.persistence.attach` | automated pass; live pending |
| P4 | `session.append.commit` | automated pass; live pending |
| P5 | `session.derivation.create` | automated pass; live pending |
| P6 | `projection.cross-version.verify` | automated pass; live pending |
| P7 | `reference.roundtrip.verify` | automated pass; user UI pending |
| P8 | `run.shutdown-recovery` | automated pass; live pending |

Only a failed breakpoint is expanded with temporary child diagnostics. No broad UI matrix is run before a real failure.

## Automated checks

- Main workspace typecheck: passed, 26 workspace projects.
- Main workspace build: passed, including Engine, Dashboard, plugin, SDK and both adapters.
- Main workspace tests: 203/206 passed on the single full run; three stale contract assertions failed. After updating only those assertions, the three focused files passed 6/6. No P1-P8 implementation failed.
- Deterministic Generation package verification: passed, 32/32 outputs, 15 artifacts, candidate ID `canonical-901d21f105135e74`.
- Package data-boundary scan: passed; no session JSONL, projection Home or SQLite database was present.
- Annotation Core: focused reference test 4/4 and build passed at `1659c7e`.
- Sticker Board: focused deep-link test 10/10 and build passed at `6445ad3`.
- Obsidian Bridge: focused protocol/backlink tests 8/8 and build passed at `56a55ec`.
- Launcher WebUI build: passed.
- Launcher Rust: compilation completed, but the Windows GNU/Tauri test executable could not start and returned the pre-existing `STATUS_ENTRYPOINT_NOT_FOUND`; this is recorded as an infrastructure limitation, not a business pass.
- Launcher configuration: Alpha2 `web` is pinned to `dsh-alpha2`; RC2 `web` is pinned to `dsh-rc2`; both use `maintenanceEndpoint: auto`. Pre-change backup: `config.pre-canonical-projection.json`.

The candidate was built before this result section was finalized. Stable registration will rebuild once, after user acceptance, so the archived report and source commit are final rather than provisional.

## Manual chain reserved for user

1. Open Maintenance WebUI.
2. Start Alpha2 and inspect the logical workspace.
3. Open one Codex mirror without sending; confirm no derivation.
4. Send exactly once; confirm exactly one derived Maintenance session.
5. Check Annotation, Sticker and Obsidian navigation and unlink behavior.
6. Close Alpha2 normally and confirm the temporary projection is removed.
7. Start RC2 and confirm the same logical workspace and session.
8. Delete and restore the test session only from Maintenance WebUI.

Stable registration and pushes remain blocked until this chain is accepted.
