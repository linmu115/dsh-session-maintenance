# Canonical Projection Generation

## Contents

The Generation contains the Session Maintenance 0.2.0 DSH entry, Engine and WebUI bundle, public contracts and Adapter SDK, Alpha2 and RC2 adapters, Launcher Profile templates, the verified Stable 1.5 plugin combination, and the Obsidian Bridge Companion snapshot.

The DSH plugin set is inherited from `gen-4a88122cf2a71716`: Sidechat, Agent Teams, Annotation Core, Better Sidebar, Resource Management, Session Context Menu, Session Maintenance, Sticker Board and Settings Scroll Fix. `dsh-codex-session-sync` remains deprecated and excluded. Obsidian Bridge is recorded as a Companion and is not inserted into the DSH bundle list.

## Build

From a clean, built source tree:

```text
node scripts/package-canonical-projection.mjs
node scripts/verify-canonical-projection-package.mjs
```

The output is `.artifacts/canonical-projection/`. `canonical-projection-generation.json` is the content-addressed manifest; `launcher-profiles.json` provides pinned Alpha2 and RC2 Profile values. The verifier builds the complete output twice, compares every file and rejects session logs, projection homes and SQLite databases inside package archives.

## Data boundary

The Generation never contains user session content, Maintenance object data, a Maintenance database, Codex logs or a DSH Profile Home. Those remain external state. Only executable packages, public documentation, manifests and profile templates are archived.

## Activation and rollback

The same Generation is configured into both Launcher Profiles. Only one Profile is run for the first acceptance cycle. A normal close must drain writes, verify P8 and clear the temporary projection before the other Profile opens.

Rollback has two independent controls:

1. restore the previous plugin Generation `gen-4a88122cf2a71716`;
2. stop Engine and point `databaseFile` back to the readonly pre-canonical `metadata.sqlite` archive.

Do not register this output as stable until the user completes the single manual Alpha2 → RC2 chain documented in the final validation report.
