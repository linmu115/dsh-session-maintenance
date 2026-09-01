# T20 — Canonical Projection Generation

## Scope

- Package Engine, WebUI, public Adapter SDK, Alpha2/RC2 adapters and the approved Stable 1.5 plugin combination as one content-addressed Generation.
- Provide Alpha2 and RC2 Launcher Profile templates pointing to the same Maintenance endpoint.
- Record exact external plugin commits and exclude the deprecated Codex Session Sync plugin.
- Verify reproducibility and reject accidental inclusion of session logs, databases or projection homes.

## Compatibility updates

- Annotation Core 0.3.5 layers logical session/anchor resolution over the verified Alpha2 0.3.4 tree.
- Sticker Board 0.4.21 layers projection-aware links over the verified Alpha2 0.4.20 tree without reverting Web Viewer and composite-anchor fixes.
- Obsidian Bridge 0.3.23 persists the same logical identity through open, unlink and background deletion.
- Session Maintenance 0.2.0 replaces native mirror ownership with a stable canonical store, version adapters and temporary Profile projections.

## Validation policy

The full workspace commands run once. External plugins run only the T14 focused files plus build. Browser control may observe page state, but the user performs the only manual end-to-end click chain. Stable registration and remote pushes happen only after that acceptance.

## Candidate result

- Candidate Generation: `canonical-901d21f105135e74`.
- Reproducibility: 32/32 output files matched across two builds.
- Main typecheck/build passed; P1-P8 focused and integration evidence passed.
- The single full test run exposed only three stale contract assertions; their three files passed after focused correction.
- Launcher WebUI build passed. Rust code compiled, while the existing Windows GNU/Tauri test host again failed to start with `STATUS_ENTRYPOINT_NOT_FOUND`.
- Alpha2 and RC2 Launcher `web` Profiles now share `maintenanceEndpoint: auto` and pin their respective adapters; the previous config is preserved as `config.pre-canonical-projection.json`.
