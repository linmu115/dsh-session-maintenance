# System audit corrections in Maintenance

This change addresses audit findings F04, F05, F06, F10 and F11. It also supplies the shared selected-note sticker contract for Companion F07. No real session database, DSH profile or Obsidian Vault is changed by this source work.

| Finding | Corrected behavior | Main regression evidence |
| --- | --- | --- |
| F04 | A staged migration records one digest of the sorted full object manifest, including source identities and pending backlink cleanup. Activation requires exact IDs, writer, live state, kind, identities, title, body and references. Reordered complete sets are accepted. Active retries verify the fixed manifest while preserving later legitimate edits. | `apps/engine/test/session-knowledge.test.ts`: empty/subset and changed-source rejection, seven staged-object corruption cases, pending cleanup/request mutation rejection, reordered A+B success, active retry after edits, and legacy receipt compatibility. |
| F05 | Execution allowances and closed-execution identities live in a compact SQLite ledger, not an unbounded process Map. Reservations are charged before reads and unused bytes are refunded once. Ended IDs cannot reopen; a new service preserves charges. Closing/recovering/quarantining the owning run removes ledger rows, and non-running runs cannot read again. | Reader regression finishes 10,005 executions and admits a new one, refuses old-ID replay after service recreation and retains an unsettled reservation; authenticated Engine regression ends/replays a turn and verifies normal run close cleans all rows. |
| F06 | The retained native manifest stores only attachment identity/size/name metadata. On unchanged starts the RC2 adapter validates immutable resources using that inventory without reopening canonical session bodies. A missing resource triggers one body load and additive repair; corruption still fails closed. | Native-space warm-start spy observes zero body loads, missing inventory repair loads only its session; real RC2 resource tests verify image and file assets, missing link repair and corrupt data refusal. |
| F10 | A preview selector or cursor stays on its retained source version after later appends. The version adapter reconstructs old material in memory and never rewrites the live session. Missing versions/bodies fail explicitly and do not fall back to latest context. | Real RC2 Engine test reads old cursor and selected reply after append, sees no future text, rejects missing version/body and still permits a fresh latest preview. |
| F11 | Network search includes independent sent/revoked upstream references, even without a canvas node. It can filter source/target titles or selected text and browse a session's incoming or outgoing references. Both full session pages are separately reachable in Dashboard. | Engine tests cover search, direction, revoked state and foreign-session rejection; Dashboard test verifies query parameters and source/target navigation. |

## Execution lifecycle and schema 23

Migration 23 adds `context_read_executions` with only a hashed execution identity, owning run, active/closed state and byte counters. No prompt, response, event copy or per-turn snapshot is stored. The compact ended-ID rows remain until their run reaches a terminal state; no TTL eviction can replenish an old execution. A crashed reservation remains conservatively charged until settlement or run recovery. All Engine read/end mutations use the existing write coordinator. Normal close and recovery close run cleanup in the same coordinated operation; the next valid read/end also prunes terminal runs.

The host service adds `endExecution(targetNativeSessionId, executionId)` at `/v1/session-context/end-execution`. Annotation Core ends initial preparation in `finally` and ends tool execution on actual host turn/session lifecycle events. The existing read request shape is unchanged. Authentication, active-run and current-session identity checks apply to ending as well as reading.

Static retention/reference readers accept schema 23 alongside prior supported schemas because the canonical reference layout is unchanged. Tests verify schema 21, 22 and 23 recovery-point bytes stay unchanged. Unknown future schema 24 remains rejected.

## Selected-note contract

`noteSelectionSchema` is exported by shared contracts and is optional on a session sticker. It stores an excerpt of at most 16,000 characters, its SHA-256 identity and occurrence index, and requires the stable `note` identity alongside it. It does not add a note snapshot. Companion implements the selection capture and durable retry workflow separately.

## Migration receipt compatibility

New receipts retain only `manifestDigest`; they do not duplicate the imported records. `manifest-verified` means the submitted complete manifest matches the fixed migration intent. A prior staged receipt without this field gets it only after a one-time full check of every staged object and its pending backlink cleanup list. A prior active receipt without a digest returns `legacy-receipt-only`: the existing active receipt is acknowledged, no new payload is certified, and no object or receipt is written. Its original source identity and exact ID mapping still must match. This preserves legitimate edits to previously migrated stickers instead of treating those edits as failed historical migrations.

## Validation

- Workspace `pnpm typecheck`: passed after implementation and test updates.
- Ten focused files, 46 tests: passed (`maintenance-focused-tests.log`).
- Authenticated Engine budget lifecycle regression rerun after adding normal-close coverage: passed (`maintenance-budget-lifecycle-tests.log`). The initial added-close attempt correctly rejected a synthetic fixture lacking native writer files; the fixture now supplies its matching native files before asserting close.
- Follow-up complete migration manifest and selected-note contract regressions: passed (`maintenance-migration-manifest-tests.log`).
- Tests use synthetic temporary roots only. Read-only source-home hashes are asserted by Engine integration fixtures.
- The existing 205-session native-space unit test covers RC1. A separately executed official RC2 Host acceptance on the same F06 implementation reads all 207 synthetic V3 histories in each of two fresh Host processes. Reused preparation performs zero canonical-body reads, zero resource preparation calls and 207 resource verifications, retaining all hashes/mtimes/sizes. The distinct exit checkpoint reads 207 bodies. Evidence: `rc2-large-native/report.md`; this remains synthetic acceptance, not a claim about the running copy's session count.

Logs are under `D:/AI/DeepSeekHarness-Plugin/artifacts/system-fixes-20260914`. Release packaging and copy deployment are separate from this functional commit.
