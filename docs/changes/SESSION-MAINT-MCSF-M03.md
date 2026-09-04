# M03 — Native Session Reference Index

## Outcome

Source bindings, navigable active DSH projections and historical session
aliases now share one read-only `NativeSessionReferenceIndexV1`. The index is
identity metadata only: it does not own or duplicate MCSF session content.

## Changes

- Added the native reference entry, use and index contracts plus strict schemas.
- Added `NativeSessionReferenceRepository` and exported the DTO/read boundary
  through the Adapter SDK.
- Added a SQLite repository that combines existing `platform_bindings`, active
  `projection_sessions` and session-level `session_aliases` without merging the
  physical tables.
- Changed stable annotation/sticker/reference resolution to select the current
  native DSH identity from the unified index.
- Added the index to the canonical Maintenance session detail and its metadata
  tab in the WebUI.
- Added schema v14 and the `reference.index` status breakpoint.

## Identity rules

- `source` identifies the external source binding, including a read-only Codex
  task when present.
- `active-projection` identifies a currently navigable DSH projection and is
  the only reference use allowed to carry a `runId`.
- `historical-alias` identifies an old session link that can still resolve to
  the logical MCSF session.
- Workspace aliases are excluded because they are not session identities.
- Within each use, database ordering is retained; therefore the most recently
  heartbeating active projection is selected for navigation.

## Safety boundaries

- No table became a second content owner and no canonical body was copied.
- The read model contains no title, event, message, tool call or raw payload.
- Codex bindings are read only; no Codex path or native log was opened for
  writing.
- Only synthetic temporary databases were used by tests.
- Closed or recovery-only projections are not advertised as navigable current
  sessions.

## Focused verification

- Repository coverage proves all three identity uses are returned in one index
  and session content is absent.
- Reference round-trip coverage proves annotation and sticker links resolve
  through the index and records a payload-free `reference.index` span.
- Dashboard coverage proves the same DTO is returned by the static session API.
- Migration coverage proves old status rows survive and schema v14 accepts the
  new breakpoint.
- `pnpm typecheck`: all 25 workspace packages passed.
- Focused Vitest run: 11 files and 19 tests passed.
