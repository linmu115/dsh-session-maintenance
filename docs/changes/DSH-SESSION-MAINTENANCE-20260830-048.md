# Session Maintenance 0.1.5 — DSH 0.1.2-alpha.1 compatibility status

## Upstream breaking change and migration

The removed `@deepseek-ai/dsh-client-runtime` dependency and injection were replaced by the actual browser service consumed by the plugin, `@deepseek-ai/dsh-api-session-controller`, declared through `dsh.client.inject`. The global entry now uses the official `settings.section` slot. The primary Engine descriptor also has a fixed trusted local fallback so an official DSH cold start does not depend on Launcher-provided environment variables.

## Verification completed

- Focused plugin typecheck, tests, build, and package dry run.
- Maintenance dependency preview with no transitive or unrelated package drift.
- Official `0.1.2-alpha.1` Web profile cold start with empty DSH stderr.
- Native Settings page loading and Engine parameter retrieval.
- Confirmation that the former floating launcher is absent.

## Verification not yet complete

Compatibility confidence remains provisional. The full matrix of cross-adapter synchronization, restore/recovery operations, long-running Engine reconnect behavior, and Generation rollback on DSH 0.1.2-alpha.1 has not been exhaustively exercised. This plugin may enter the Generation, but its notes must retain this limitation until that matrix is completed.
