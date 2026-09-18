# Instance workspace synchronization policy foundation

Maintenance can now persist one authoritative workspace selection per DSH instance. Profiles and Vaults do not own competing policy rows. An unconfigured instance retains the previous all-workspace behavior without writing a default row. An explicit ID selection can be empty; `includeUnassigned` independently controls sessions without a workspace membership.

The shared contracts use canonical `LogicalWorkspaceId`, not project IDs or Codex source keys. Strict schemas reject duplicate and whitespace-contaminated identities, ambiguous selection shapes, and extra profile/Vault keys. Effective-scope and session-availability DTOs distinguish scope exclusion from offline, pending native mappings, deletion and unknown sessions. Available sessions require a native mapping.

Migration 026 only creates the policy table. The synchronous repository supports revision compare-and-swap, validates selected workspaces against current nondeleted canonical workspaces, and preserves saved identities when a workspace is subsequently soft-deleted. Policy updates never delete canonical sessions, memberships, aliases or reference data. Savepoints compose with Engine writer transactions, including rollback of an outer transaction.

`sessionScope` and `assertSessionAllowed` read current policy and canonical membership synchronously. The Engine must invoke them inside the actual canonical commit transaction, including deferred WAL recovery, rather than rely only on an earlier HTTP/queue check. These checks do not assert that a native mapping exists or that an instance is online; Engine resolves those independent availability conditions.

Validation: focused contract and SQLite fixture tests cover implicit all, explicit none/unassigned, instance isolation, membership changes, missing/deleted sessions, cross-connection stale revisions, invalid workspaces, savepoint/outer rollback, reselection, and schema 25-to-26 upgrade/reopen. Contracts and session-store TypeScript checks pass. Tests use marked synthetic temporary directories only.

This change is the contract/store foundation. Runtime projection filtering, commit fencing, instance settings and Bridge-facing API integration belong to separate implementation work; the repository alone does not activate runtime synchronization filtering.
