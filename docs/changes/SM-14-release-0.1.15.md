# SM-14: Engine 0.1.15 / Maintenance 0.2.17 release preparation

The user requested committing and activating the currently completed batch,
then personally accepting the running UI. This release includes SM-00 through
SM-04 and the separate SCM 0.3.2 action host (`0a98ea9`). It preserves the RC1
identity and empty-session fixes from the clean `4b49927` ancestor.

It does not include paused SM-05 import coordination, unfinished SM-13 Launcher
changes, the Maintenance menu consumer, five-day retention or automatic GC.
The existing Launcher executable and its deployed hook protocol remain in use;
only the configured Engine installation path changes during activation.

Validation before packaging: workspace typecheck and build passed. Across the
158-file / 458-test suite, 456 passed in the initial two-worker run; the large
catalog timeout and a build-output scan race both passed when their two files
were rerun serially (3/3 tests, no timeout increase or assertions removed).
The separate SCM build, syntax check and all 34 tests passed.

The upgrade-copy verifier was committed as `45afcae`. Packaging records exact
source identity, schema 17, component versions, protocol versions, lockfile
digest and artifact hashes. The activation report will record portable-package
checks, the real database copy migration, rollback location and observed live
versions. Preparation alone is not live acceptance.

Pre-existing operational finding: the last stopped RC1 run, created at
2026-09-05T13:16:17.910Z, has a recovery-required receipt due to a SessionHeader
mismatch. Its seven database operations are already committed. The original
run, WAL, native artifacts and historical recovery records must be preserved
in the rollback set; this release must not claim that the recovery issue is
fixed, clear its state or reclaim its files.
