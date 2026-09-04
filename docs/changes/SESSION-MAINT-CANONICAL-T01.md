# T01 — Canonical projection contracts

## Scope

This task establishes the shared DTO and interface vocabulary for the canonical
session source design. It changes only packages/contracts and does not add a
database migration, runtime projection, status log writer, or platform write.

## Changes

- Added branded identifiers for logical sessions, versions, workspaces, runs,
  leases, branches, operations, adapters, native sessions, checkpoints, and
  status spans.
- Added canonical session, event, workspace, derivation, membership, and
  tombstone records.
- Added projection run, projection session, and operation receipt records.
- Added the fixed P1-P8 status stage union and status event/query records.
- Added Adapter manifest, capability, probe, projection, append, inspection,
  reference, and Runtime Bridge DTOs.
- Added the small DshSessionAdapterV1 and DshRuntimeBridgeV1 interfaces.
- Added minimal CanonicalSessionRepository, ProjectionRunRepository, and
  StatusEventRepository interfaces.
- Added strict Zod schemas and HTTP response DTOs for the new records.
- Marked NativeMirror contracts as legacy without removing them, so existing
  packages keep compiling until the planned T19 replacement.

## Focused verification

Commands:

    pnpm exec vitest run packages/contracts/test/canonical-projection-contracts.test.ts packages/contracts/test/contracts.test.ts
    pnpm --filter @linmu/dsh-session-contracts typecheck

Results:

- 2 test files passed.
- 7 tests passed.
- The contracts package typecheck passed.
- Invalid authority values, unknown status stages, and Adapter interface major
  versions are rejected.
- Opaque native event payloads survive schema parsing.
- A new DSH draft may have a null base version before its first durable append.

## Breakpoint policy

T01 defines the stable P1-P8 stage names but does not emit runtime status events.
No child diagnostic stage was added because the focused contract verification
passed after the expected initial missing-schema failure.

## Safety

- No real Codex or DSH home was read or written.
- No database or Launcher Profile was changed.
- No runtime package imports the new path yet.
