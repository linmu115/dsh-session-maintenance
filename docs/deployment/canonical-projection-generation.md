# Canonical Projection Generation packaging

This page describes the existing multi-repository Generation script, not the current live release receipt. The 2026-09-01 candidate and its uncompleted manual gates remain in the [historical validation report](../validation/canonical-projection-final.md). Current runtime baseline and Dashboard candidate status are in [README](../../README.md).

## Current script scope

`package-canonical-projection.mjs` assembles Engine+WebUI, the Maintenance plugin, public contracts/SDK, standalone Alpha2 and RC2 adapters, pinned Alpha2/RC2 Launcher profile templates, a baseline plugin Generation and Companion packages. Package versions come from source manifests; the old Maintenance 0.2.0 description is not a current release version.

The script defaults to baseline `gen-4a88122cf2a71716` and reads adjacent repository/build inputs plus the configured Maintenance state root for Generation packaging inputs. It requires that environment; it is not a standalone RC1 release recipe. RC1 exists in current Engine source, but this script's standalone adapter/template list has not been extended to RC1. Do not infer a tested RC1 combination from successful legacy Generation packaging.

```powershell
pnpm package:canonical
pnpm verify:canonical-package
```

Default output is `.artifacts/canonical-projection/`. `canonical-projection-generation.json` records the content-addressed manifest; `launcher-profiles.json` holds the template values. The verifier compares repeated output and checks that archives exclude session logs, projection homes and SQLite databases. This is packaging evidence, not live UI acceptance.

For Engine+Dashboard and the Maintenance plugin alone, use `pnpm package:phase2` and `pnpm verify:phase2-package`; see [INSTALL](INSTALL.md). SCM, Launcher Hook and the chosen DSH runtime still need their own matching release evidence.

## Data and activation

Executable packages, documentation and manifests may be archived; user session content, Canonical objects/database, credentials and DSH Profile Homes remain external state. Old synchronization runtime remains excluded. Obsidian Bridge is a Companion, not a DSH bundle entry.

A build does not activate or register a stable Generation. Activation must record actual runtime versions, normal shutdown/drain, restart, source/derived identity, append acknowledgement, stable references and recovery. Historical candidate gates remain historical until separately completed. Upgrade and rollback use [UPGRADE](UPGRADE.md) and [RECOVERY](RECOVERY.md); do not blindly restore the old pre-canonical database or baseline Generation from the 2026-09-01 instructions.
