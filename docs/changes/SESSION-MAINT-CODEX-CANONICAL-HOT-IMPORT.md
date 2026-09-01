# Codex canonical hot import

The trusted import seam now reads a live Codex WAL snapshot through `CodexReadAdapter` and sends stable normalized sessions directly to `CanonicalSessionEngine.observeCodex`. It does not populate the deprecated discovery-only session model.

Each import persists a deterministic Codex authority binding and platform ref. Re-reading identical content returns `noop`; only an actual body or metadata change advances the canonical head. Codex native storage remains read-only.

Project and workspace are intentionally separate:

- project resolution order is `threads.project_id`, explicit override, unique longest saved project root, `待指定项目`, then `Codex 项目外`;
- workspace remains the session's original `cwd` and its stable workspace ID;
- `SqliteCodexProjectPort` writes the project, its roots, and session membership to schema migration 009;
- the workspace directory is ensured independently before canonical import, so the canonical membership keeps the original Codex `cwd` identity;
- a projected DSH `SessionHeader.cwd` is never used to overwrite Maintenance's stored workspace.

Structured breakpoints cover `catalog.snapshot`, `rollout.stability`, and `canonical.import`. A moving rollout is retried on the next incremental scan rather than imported partially.
