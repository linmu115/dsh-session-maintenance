# Changelog

## Unreleased

- Add the client-neutral Runtime Broker `prepare`, `attach`, `append`, `flush`,
  `drain` and owner-only `close` protocol for Alpha2 temporary projections.
- Observe Alpha2's public `session/event` and `session/flush` hooks with ordered
  per-session retry queues and explicit WAL/canonical durability status logs.
- Register sessions created during an active DSH run from their exact native
  header before committing the first live event.
- Require a plugin runtime-drained acknowledgement before normal process-owner
  close, checkpoint and temporary projection cleanup.

## 0.2.0 - 2026-08-31

- Replace per-instance native mirror ownership with a Maintenance canonical session store and stable logical workspaces.
- Add temporary Alpha2 and RC2 projections, runtime append commit, clean shutdown, WAL recovery and single-writer leases.
- Preserve Codex as an independent authority; identical observations are no-ops and first DSH continuation creates one derived session.
- Add public Adapter SDK, isolated Adapter Host, Alpha2 and RC2 adapters, experimental selection and compatibility reports.
- Resolve Annotation, Sticker and Obsidian links through logical session and anchor IDs while retaining historical aliases.
- Add the standalone canonical WebUI for static browsing, lineage, move, delete, restore, Checkpoint and P1-P8 diagnostics.
- Add Launcher maintenance-backed Profile metadata without storing permanent session directories.

The Alpha2 and RC2 end-to-end manual chain remains a user acceptance gate before this Generation is registered as stable.
