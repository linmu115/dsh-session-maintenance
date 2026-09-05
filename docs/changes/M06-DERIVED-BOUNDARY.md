# M06 derived-session fork and deletion boundary

The candidate repair previously selected every derivation whose parent was refreshed. This included deleted children, which were subsequently passed to an RC1 projection loader that intentionally excludes tombstoned sessions. It also combined the complete refreshed parent head with the child's old DSH suffix without establishing that the parent still represented the child's immutable fork boundary.

## Changes

- Preview and staging now select only children without a session deletion marker or an unrestored tombstone. Recomposition checks the loaded child's deletion state again before reading its lineage or writing a replacement head.
- A focused Engine helper verifies that every repaired-parent source occurrence is a unique, strictly ordered member of the immutable base. Its identity is the complete platform, instance, source session, and event ID tuple. Missing identities, duplicates on either side, unknown sources, and reordered sources reject candidate staging before the affected child's head is written.
- The check permits legal normalization of canonical event IDs, digests, content, and normalized cursors, as well as removal of log-only events. These fields cannot establish the fork boundary. The original exact child/base prefix check remains in place for determining the child's existing DSH suffix.
- Deleted children retain their head, tombstone, derivation, and stored suffix. They are not added to the recomposed or RC1 verification lists. Existing immutable derivation records are not rewritten.

## Validation

- `pnpm exec vitest run apps/engine/test/conversation-derived-boundary.test.ts apps/engine/test/conversation-topology-repair.test.ts --maxWorkers=1`: 15 tests passed across two files.
- `pnpm --filter @linmu/dsh-session-maintenance-engine typecheck`: passed.
- `git diff --check`: passed; Git only reported its existing Windows line-ending conversion notices.

The twelve focused boundary cases cover legal normalization and source omission, parent history advancing beyond the fork, reordering, complete source namespaces, duplicate identities, and missing identities. Three synthetic candidate scenarios cover active recomposition, unchanged deleted children excluded from verification, and rejection of a parent that advanced after the child's fork. The rejected candidate preserves the child's existing head and derivation; tests also confirm the source fixture database and Codex fixture remain unchanged by staging.

Only marked synthetic fixture directories were used for candidate and activation-callback tests. No real Maintenance database, Codex home, DSH home, runtime configuration, or existing process was changed. No production staging, activation, restart, or Git commit was performed by this subtask.

## Deliberate failure mode

When a repaired parent cannot be tied to the old base through unambiguous ordered source identities, the repair fails rather than importing possible future parent history. Recovering such a child requires additional preserved provenance or a separately reviewed reconstruction of its exact base; automatically truncating a newer parent or rebasing the child is outside this change.
