# T14 — Stable logical reference round trips

## Outcome

- Added stable reference contracts for Annotation, Sticker and Obsidian references.
- Added active projection resolution from `logicalSessionId` to the current native DSH session and anchor.
- Added historical native-link resolution through `session_aliases`.
- Exposed the resolver through the authenticated Engine route and the restricted same-origin DSH plugin proxy.
- Added durable P7 `reference.roundtrip.verify` status events containing only reference type, IDs and resolution state. Reference bodies are never written to status diagnostics.
- Updated Annotation Core 0.3.3, Sticker Board 0.4.6 and Obsidian Bridge 0.3.23 to persist and consume logical targets while retaining legacy fallbacks.
- Existing local-first deletion semantics remain intact; cross-version sticker unlink uses the stable sticker identity.

## Focused breakpoints

- Maintenance: logical target, historical alias and closed-run behavior; P7 body-redaction assertion.
- Annotation Core: active projection resolution and native fallback.
- Sticker Board: logical sticker target resolves before session open.
- Obsidian Bridge: logical protocol persistence, committed reference navigation and cross-version unlink.

## Verification

- `pnpm vitest run --maxWorkers=1 --testTimeout=15000 tests/integration/reference-roundtrip.test.ts plugins/dsh-session-maintenance/test/proxy.test.ts`
- Directly affected package typechecks.
- External focused tests and builds listed in their change records.

All fixtures used temporary synthetic state. No real Codex Home, DSH Home, Launcher profile or Obsidian Vault was written.
