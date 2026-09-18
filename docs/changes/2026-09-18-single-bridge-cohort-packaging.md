# Single Bridge cohort packaging — 2026-09-18

Engine 0.1.33-rc2.38 now accepts the deployed Sticker 0.7.3-rc2.19 and candidate Sticker 0.7.4-rc2.3, together with ThoughtDAG 0.4.14-rc2.14, through their existing historical-data adapters. This changes version admission only; it does not add alternate message schemas or move plugin responsibilities.

Release packaging now includes Maintenance 0.2.26-rc2.29's public `business-pages.js` and generated `business-pages.d.ts`, and checks both when a supplied plugin archive is compared. The Engine embeds the same complete plugin archive. The shared declaration generator remains the single source for the public types.

The synthetic schema-21 upgrade fixture now removes the learning trigger/tables and instance/run workspace policy tables introduced in migrations 25–27, as well as the existing post-21 objects. Reopening therefore tests a real old-schema boundary rather than a current database with only migration records removed. Production migrations are unchanged and existing session rows remain equal after upgrade.

Validation passed: both Engine suites (12 tests), Engine no-emit typecheck and TypeScript build. An isolated candidate package was verified for byte-identical embedded plugin content, correct public export targets, inert runtime import, and independent TypeScript provider/service consumption. The final candidate is regenerated after this commit under `.artifacts/single-bridge-20260918` so its manifest identifies the committed sources; its SHA-256 and verification result are local release evidence. No deployment or shared-state access was performed.
