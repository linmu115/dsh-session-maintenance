# Engine connection descriptor compatibility

The Engine wrote `pid` and `ownerId` into `connection.json`, while the external lifecycle Provider's strict local schema accepted only the original four fields. A healthy running Engine was therefore rejected during discovery, causing another start attempt.

Adds one shared `EngineConnectionDescriptor` and `engineConnectionDescriptorSchema` in contracts, used by both the server writer and Provider reader. Original four-field loopback v1 descriptors remain valid. Optional `pid` must be a positive safe integer and optional `ownerId` must be a UUID. Unknown fields and invalid ownership metadata remain rejected. The existing bounded loopback port and capability validation are retained, with the token bounded to the same 32–256 characters already accepted by DSH readers.

The regression starts the actual Maintenance server through the Engine fixture, reads its actual connection file with the Provider's default discovery path, and completes prepare/abort followed by another prepare/afterExit. Each format performs four successful health checks and never calls `startEngine`. It tests both the newly written ownership fields and the legacy four-field representation. No `connection()` override is used. DSH plugin `FileConnectionProvider` and Engine gateway reading are checked against both actual file formats as well.

Reader audit found no other strict old-field parser: DSH plugin, Engine gateway, Codex MCP, online CLI and acceptance scripts read selected fields and already tolerate the ownership fields. `local-api-client` receives origin/token rather than reading the file. No changes to those readers were needed.

Validation: four focused test files, **41 tests passed**; full workspace `pnpm typecheck` and `pnpm build` passed. The focused suite was repeated after the build refreshed worker artifacts. All server, state and platform data used marked synthetic fixtures. No deployment, real state/home access, version or lockfile changes are included.
