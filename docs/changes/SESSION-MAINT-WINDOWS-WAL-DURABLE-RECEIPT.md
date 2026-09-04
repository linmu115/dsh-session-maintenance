# Windows WAL durable-receipt repair

Date: 2026-09-02

## Failure boundary

An Alpha2 append reached the temporary projection and updated its catalog, but
the WAL could not advance from `pending` to `projectionApplied`. The WAL target
basename was 220 characters. The former atomic update appended a UUID and
`.tmp`, producing a 261-character NTFS path component and failing beyond the
Windows 255-character component limit.

The retry reused the deterministic operation ID but generated a fresh
`observedAt`. The WAL compared the entire envelope, so the otherwise identical
retry was then rejected as different content. DSH surfaced the combined result
as `Projection append did not reach a durable Maintenance receipt`.

## Repair

- Use short sibling names for WAL and projection atomic temporary files instead
  of extending the potentially long target basename.
- Treat `observedAt` as receipt metadata rather than operation identity. A
  retry with the same run, native session, revision and payload reuses the
  original durable WAL record.
- Preserve the original observation timestamp stored in that WAL record.

## Focused acceptance evidence

- A synthetic long native session/operation ID advances through pending,
  projection-applied and committed states on Windows.
- The same operation with a later retry timestamp resolves to the existing WAL
  record rather than reporting an operation-ID collision.
- Projection lifecycle append/recovery tests remain the next validation
  boundary before live recovery.
