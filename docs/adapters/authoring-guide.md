# Authoring guide

1. Depend only on `@linmu/dsh-session-adapter-sdk` for the public contract.
2. Define the manifest with `defineAdapterManifest`.
3. Implement the codec with `defineDshSessionAdapter`.
4. Implement attach/drain/detach with `defineDshRuntimeBridge`.
5. Preserve unknown native events as `opaque-unknown` with raw payload.
6. Compute deterministic catalog and per-session digests.
7. For persistent startup-delta caches, implement `composeProjectionManifest`.
   It must rebuild the full projection manifest from cached session digests and
   workspace IDs without opening unchanged session bodies. The Adapter ID is a
   native-format-family identity: compatible product releases share it; a
   breaking native format requires a new, manually reviewed Adapter.
8. Resolve links from logical IDs; accept old native IDs only as historical
   aliases supplied by Core.
9. Run Core Smoke against synthetic fixtures.

`materialize` may receive either the complete baseline or a selected set of
changed sessions. It must write only through `ProjectionWriter` and must not
assume that every call represents a fresh directory. Exact native fields are
maintained manually from official source/types, official fixtures, and
synthetic isolated logs; automatic schema guessing is not an Adapter.

Never import `@linmu/dsh-session-store`, `node:sqlite`, Engine internals, or a
Maintenance database path. Ask for a new SDK DTO/capability instead.
