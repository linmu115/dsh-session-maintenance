# SM-14: verify additive upgrades on an isolated database copy

The release verifier opens the supplied database read-only and uses SQLite's
online backup API to create a consistent copy in a marked temporary fixture.
Only that copy is passed to the candidate portable Engine. No real home
registrations, connection credentials or external object files are copied into
the fixture, and no model is invoked.

The verifier checks SQLite integrity and foreign keys, then compares streaming
row hashes and counts for logical sessions, canonical events, versions, parent
edges, derivations and checkpoints before and after migration. It also verifies
the declared build schema and a second idempotent open. Existing metadata
snapshots, when present, must remain unchanged.

The focused Node tests exercise a synthetic schema 16 database with a real
conversation and version edge, verify that the source bytes stay unchanged,
and reject missing or invalid build metadata. Tests require the candidate archive
in `DSH_UPGRADE_TEST_ENGINE_PACKAGE`; a skipped positive test is not release
acceptance. Initial development verification: 3/3 passed. The final release
record will contain validation for the versioned archive and live database copy.

This verifier does not perform live migration, cleanup, rollback or installation.
Activation and the user's UI acceptance are recorded separately.
