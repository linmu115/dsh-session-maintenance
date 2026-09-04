# T17 — RC2 Adapter and cross-version projection verification

## Outcome

- Added `@linmu/dsh-session-adapter-rc2` as an independent public-SDK Adapter; it does not copy or own `ProjectionLifecycle`.
- RC2 materialization writes version-0 `session` headers, logical workspace-to-project projection and contiguous RC2 event envelopes.
- RC2 append normalization produces `CanonicalEventV1`. Unknown Annotation, Sticker, Obsidian and plugin events retain their complete native envelopes and are reported as held-out.
- Added a package-local Runtime Bridge around `legacySessionPersistence`; the legacy hook does not leak into canonical storage or Alpha2 code.
- Stable logical references resolve to deterministic run-local RC2 native IDs and preserve logical anchors.
- Registered RC2 alongside Alpha2 in the Engine Adapter registry. Both declare `*`; exact versions are verification evidence rather than installation locks.
- Added an Adapter-SDK logical projection digest that excludes run/native IDs and native file layout. It is used only for cross-version semantic verification.
- Added sequential Alpha2-close -> RC2-open verification for the same logical workspace, session head version and reference target.
- P6 records the two run IDs through the diagnostic reference, the active Adapter through the status event and the canonical catalog digest. No conversation body is logged.

## DSH breaking changes covered

- RC2 uses a legacy persistence hook while Alpha2 uses `sessionPersistence`.
- RC2 requires `type=session`, format `version=0`, `cwd` and `delegationDepth` header fields.
- Private `session/imported` events are never emitted; unknown events remain held-out raw envelopes.
- Native workspace/session IDs are temporary projection details; canonical workspace, session, version and reference identities remain stable across versions.

## Focused breakpoints

- RC2 Core Smoke: probe, materialize, inspect, verify, append normalize, runtime attach/drain and reference resolution.
- Cross-version P6: Alpha2 closes completely before RC2 opens; adapter-neutral logical digest remains equal.
- Launcher Profile Home fixture remains empty because all temporary content is written under the Maintenance runtime root.

## Verification

- `pnpm exec vitest run packages/adapter-dsh-rc2/test/core-smoke.test.ts tests/integration/cross-version-projection.test.ts`
- RC2 Adapter and Adapter SDK typechecks.
- RC2 Adapter production build.

All verification used synthetic temporary directories. No real DSH Profile Home or user session was written.
