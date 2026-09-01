# Changelog

## 0.2.0 - 2026-08-31

- Replace per-instance native mirror ownership with a Maintenance canonical session store and stable logical workspaces.
- Add temporary Alpha2 and RC2 projections, runtime append commit, clean shutdown, WAL recovery and single-writer leases.
- Preserve Codex as an independent authority; identical observations are no-ops and first DSH continuation creates one derived session.
- Add public Adapter SDK, isolated Adapter Host, Alpha2 and RC2 adapters, experimental selection and compatibility reports.
- Resolve Annotation, Sticker and Obsidian links through logical session and anchor IDs while retaining historical aliases.
- Add the standalone canonical WebUI for static browsing, lineage, move, delete, restore, Checkpoint and P1-P8 diagnostics.
- Add Launcher maintenance-backed Profile metadata without storing permanent session directories.

The Alpha2 and RC2 end-to-end manual chain remains a user acceptance gate before this Generation is registered as stable.
