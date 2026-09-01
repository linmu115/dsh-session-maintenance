# T21 — Logical project directory and safe static Markdown

## Outcome

- Maintenance now models `project` and `workspace` as independent session dimensions.
- Schema v9 adds `logical_projects`, `project_roots`, and `project_memberships` without changing or deriving data from `logical_workspaces` / `workspace_memberships`.
- Existing sessions remain in `待指定项目` after migration. A later Codex import or explicit Maintenance operation must assign them; migration never guesses a project from `cwd`.
- The Dashboard session directory reads `/v1/canonical/projects` and groups sessions by project. Session details show project, project roots, and workspace separately.
- `CanonicalProjectionSessionInput` can carry `projectId` and `projectRoot` for a version adapter to map to native `SessionHeader.cwd`. These fields do not overwrite the canonical workspace relation and this task does not change any Adapter, Lifecycle, or Runtime Broker implementation.

## Static transcript safety

- User, assistant, system, reasoning, annotation, sticker, and Obsidian-reference text is rendered as GitHub-flavored Markdown.
- Raw HTML is discarded.
- Images render as inert text placeholders and never issue network requests.
- Unsafe URL schemes are removed.
- Tool calls, tool results, attachments, system metadata, JSON values, and opaque events remain code or held-out displays; no historical tool or script is executed.

## Migration semantics

- v8 to v9 is additive.
- No project membership is backfilled from a workspace or native DSH identifier.
- Project roots permit the same normalized path in more than one project so the importer can detect ambiguity instead of silently choosing one.
- A project membership is revisioned and single-valued per logical session; workspace membership remains separately revisioned and single-valued.

## Focused verification

- `pnpm exec vitest run packages/contracts/test/canonical-projection-contracts.test.ts packages/session-store/test/migration-009.test.ts apps/engine/test/canonical-dashboard-api.test.ts apps/dashboard/test/canonical-workspace-model.test.ts apps/dashboard/test/safe-markdown.test.tsx apps/dashboard/test/summary-loader.test.ts`
- Result: 6 files, 12 tests passed.
- Contracts, session store, local API client, Engine, and Dashboard focused typechecks passed.
- Dashboard production build passed.

All database tests use temporary synthetic databases. No real Codex Home, DSH Home, Launcher Profile, projection directory, or active Maintenance database was opened or modified.
