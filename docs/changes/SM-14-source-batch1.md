# SM-14: source batch 1 integration and package identity

Date: 2026-09-05. Integration source is `4162ecb`, including the protected
`4b49927` baseline, Dashboard discovery, current documentation, and SM-02.
This is a source integration checkpoint, not a production release.

The portable packager now records Engine/plugin/Adapter component versions,
metadata schema, protocol versions, the source commit and dirty status, and the
pinned lockfile digest. The Engine archive carries the same BUILD-INFO.json as
the external artifact manifest. The portable verifier rejects mismatched source
versions, schema, lockfile, component inventory, or embedded build identity.
Artifact hashes and byte counts remain in the external manifest so the archive
does not recursively include its own digest.

The Dashboard CLI smoke verifier now waits for the CLI startup announcement.
Previously it treated connection.json creation as readiness, even though Windows
ACL setup and CLI signal registration happen afterward. It also consumes each
HTTP response before requesting shutdown, and reports delayed shutdown resource
types only on failure. Both changes concern the isolated test harness, not the
live server or user configuration. Two earlier checks reached successful page
and authentication responses but timed out during shutdown; after the readiness
change, three consecutive complete checks exited normally with code 0.

Validation:

- SM-02 integration: 5 focused files / 16 tests passed, including immutable
  metadata, derivation, HTTP metadata transactions, exact deletion, and RC1 empty
  sessions. The source agent separately passed 41 files / 98 tests, typecheck,
  and build before integration.
- Full workspace build passed at the integrated source.
- Portable package verification passed: 27 files, artifact hashes, component
  identities, worker execution, Dashboard layout, and forbidden dependency/path
  checks.
- Packaged CLI, default Dashboard discovery, static application, one-time
  authentication, cookie bootstrap, unauthorized API rejection and normal
  shutdown passed using marked synthetic directories only.
- SCM host commit `e8ba84e` was reviewed separately. Its exact installed source
  ancestor is `3833cb9`; 34 SCM tests and build/check passed. It is not mixed into
  this repository and is not yet installed.

The intermediate package used Engine 0.1.14 / plugin 0.2.16 labels and explicitly
recorded sourceDirty=true. It is not an upload or installation candidate. Its
Engine hash was `sha256:e0e558374a592f4d57282a760b034198138c0e57bc923578e18e1838fb30f4d0`
and plugin hash `sha256:bf332dfd1d1bac710761454f33b8251d6c6cf52b81eb3e05cbfda8bdd7c514fa`.
Final release allocation and reproducible clean packages follow the remaining
approved tasks; these intermediate hashes must not be reused as final evidence.

No migration, process restart, profile installation, reclamation or Git push
has been performed against the live system. The primary source remains clean at
`4b49927`; schema 17 is confined to synthetic fixtures. A database upgraded to
schema 17 requires a compatible binary or a consistent pre-upgrade recovery
point. The execution ledger records the still-pending tasks and live activation.
