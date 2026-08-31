# Authoring guide

1. Depend only on `@linmu/dsh-session-adapter-sdk` for the public contract.
2. Define the manifest with `defineAdapterManifest`.
3. Implement the codec with `defineDshSessionAdapter`.
4. Implement attach/drain/detach with `defineDshRuntimeBridge`.
5. Preserve unknown native events as `opaque-unknown` with raw payload.
6. Compute deterministic catalog and per-session digests.
7. Resolve links from logical IDs; accept old native IDs only as historical
   aliases supplied by Core.
8. Run Core Smoke against synthetic fixtures.

Never import `@linmu/dsh-session-store`, `node:sqlite`, Engine internals, or a
Maintenance database path. Ask for a new SDK DTO/capability instead.
