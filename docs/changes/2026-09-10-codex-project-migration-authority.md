# Codex project membership during directory migration

Engine 0.1.30 / Codex read adapter 0.1.2.

## Problem and behavior

RC1 copy acceptance was blocked by eight `Conflicting explicit project membership`
errors. The local and ChatGPT-linked AI-for-Math projects have distinct identities.
Desktop assignments pointed to the selected ChatGPT-linked project, while SQLite
thread membership pointed to the other local project. The supported migration
record explicitly said `projectsMigrated: true, threadAssignmentsMigrated: false`.

The adapter previously treated both records as equally authoritative and stopped
all mapping activation, even though the desktop was still editing its assignment
map. Installed Codex Desktop 26.903.8094.0 confirms this phase: its project backend
marks directory migration complete with thread migration false; its thread
assignment service persists edits to `THREAD_PROJECT_ASSIGNMENTS` and broadcasts
those changes. It does not update SQLite membership in that assignment service.
Only relevant installed application code and project membership metadata were
inspected; no source history was edited.

For the explicit supported directory-only migration phase, a valid desktop
assignment now takes precedence. Once thread migration is complete, SQLite remains
authoritative, including null membership. Missing migration authority still
rejects a disagreement; unsupported/malformed migration, unknown identities,
ambiguous identity mappings, and unstable reads still make the directory unsafe.
This does not merge projects by name or root, change the five-project selection,
disable the startup safety check, or rewrite Codex metadata.

## Validation

- Project directory and Engine mapping tests: 22 passed. The regression preserves
  distinct same-name project IDs and selected cloud-linked membership; verifies
  migration completion switches authority; verifies source JSON/SQLite bytes are
  unchanged; retains unknown-phase conflict rejection and unsafe cleanup blocking.
- A read-only live adapter check returns `safeForSelection: true`, zero issues,
  and all eight affected threads assigned to the existing ChatGPT-linked project
  with `desktop-explicit` evidence.
- Workspace build and typecheck; packaged deployment and RC1 copy lifecycle
  acceptance are recorded in the local release acceptance files.

Persistent native sessions remain the scope implemented in `fd6db7a`. This patch
unblocks their real-copy startup acceptance without changing the native format or
plugin protocol; DSH plugin 0.2.23 and RC1 adapter 0.1.5 remain compatible.
