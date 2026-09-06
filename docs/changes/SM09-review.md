# SM-09 independent retention regression review

Adds ten permanent synthetic regressions in `packages/session-store/test/retention-independent.test.ts`. The test uses repository-relative imports and requires the integrated SM-05 coordinator and SM-08/09 retention implementation, including storage commit `f08bf8357f9f7b8799c4663489174108749ef14a`.

Coverage:

- Reject object namespace/resource overlap in both directions, including a registered object root without a source.
- Keep an unknown nested sibling from being hidden by a registered resource.
- Preserve the sole retained snapshot's object references while the main database and manifest occupy different locations during quarantine or restore.
- Resume interrupted quarantine, restore and purge; close and reopen both the database and write coordinator to verify persisted recovery evidence.
- Reject unknown companion files before release and after a partial purge, while leaving those files and canonical content objects intact.

Validation: the independent ten tests and four existing retention suites passed together, **36/36**, in 62.36 seconds. The permanent relative-import test file then passed **10/10** in 19.96 seconds after formatting. Because this SM-05 checkout predates retention, that last run used an ignored local resolver to read the reviewed storage implementation and this checkout's coordinator without copying production files. No resolver or absolute worktree path is included in the permanent test.

Run after integration:

```sh
pnpm exec vitest run packages/session-store/test/retention-independent.test.ts --maxWorkers=1 --testTimeout=30000
```

No production changes are included. All fixtures use marked synthetic directories. Integration and storage worktrees were read only during this review; the complete integrated suite remains the coordinator's final acceptance check.
