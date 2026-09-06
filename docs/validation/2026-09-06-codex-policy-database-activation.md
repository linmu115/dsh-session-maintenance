# Codex project policy protection at database activation

The generic `activateDatabaseFile` configuration entry now verifies Codex mapping policy before replacing the active database pointer. If the current database has a configured policy, the candidate must preserve the entire saved and active policy, including both revisions, both selections, configured flags and future-session behavior. Candidate files are opened read-only. A missing file, missing policy table/row, stale revision, different saved/active selection, unconfigured candidate or malformed policy rejects activation before the configuration file is written. An unreadable current policy also fails closed.

Unconfigured installations retain their previous pointer behavior. The policy guard does not add candidate requirements when the current database is absent, has a legacy schema without policy, or explicitly remains unconfigured.

The existing read/equality helpers were extracted into `codex-project-policy-storage.ts`, which depends only on SQLite types and the shared policy contract. `codex-project-mapping-offline.ts` re-exports the existing names for compatibility. Configuration depends on the pure storage module, avoiding a configuration/offline-helper import cycle.

Validation used marked synthetic directories only:

- `config-codex-policy-activation.test.ts`: 15 tests passed. Identical active and pending-first-activation policies can switch databases; policy field ordering in stored JSON is harmless. Rejected candidates leave the configuration pointer bytes and current database bytes unchanged, and attempting a missing read-only candidate does not create it. Legacy/unconfigured behavior remains covered.
- Existing `codex-project-mapping-offline.test.ts`: 8 tests passed after helper extraction.
- Existing `config.test.ts`: 1 test passed.
- Engine typecheck passed.

No real Codex or DSH homes were read or changed, and no commit was created by this subtask.
