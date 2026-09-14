# RC2 system-audit release pair

Engine `0.1.33-rc2.14` and DSH plugin `0.2.26-rc2.10` package the Maintenance fixes described in `2026-09-14-system-audit-fixes.md`. The metadata schema advances from 22 to 23 for the compact context-execution ledger; the canonical session and extension layouts stay unchanged.

Exact extension compatibility adds Annotation Core `0.3.12-rc2.7`, ThoughtDAG `0.4.14-rc2.5`, Sticker Board `0.7.3-rc2.12` and Obsidian Companion `0.6.4-rc2.5`, retaining previously accepted versions. Launcher discovery accepts the new plugin and artifact attestation accepts the new Engine version.

The release-specific suite passed 30 checks across Launcher integration discovery, runtime artifact attestation, authenticated upstream lifecycle and the full new extension combination. Functional checks passed 46 tests and workspace type checking passed before release preparation. Packaging must verify `sourceDirty: false`, schema 23 and byte-identical embedded/standalone integration archives. The paired package is built into `artifacts/system-fixes-20260914/engine-package` outside the repository.

Installation into the running copy is handled separately with a fresh pre-schema-change recovery point. No runtime database or Vault is modified while preparing this release.
