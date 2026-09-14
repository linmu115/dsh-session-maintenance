# System audit corrections in Maintenance

This change addresses audit findings F04, F05, F06, F10 and F11. It also supplies the shared selected-note sticker contract for Companion F07. No real session database, DSH profile or Obsidian Vault is changed by this source work.

| Finding | Corrected behavior | Main regression evidence |
| --- | --- | --- |
| F04 | A staged legacy migration can activate only the exact legacy-ID set and source revision recorded by its receipt. Empty/subset activation fails before publication. Reordering the complete set is accepted; each staged object still must match its supplied content. | `apps/engine/test/session-knowledge.test.ts`: empty, changed revision, changed content, A+B → A rejection, reordered A+B success. |
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

## Validation

- Workspace `pnpm typecheck`: passed after implementation and test updates.
- Ten focused files, 46 tests: passed (`maintenance-focused-tests.log`).
- Authenticated Engine budget lifecycle regression rerun after adding normal-close coverage: passed (`maintenance-budget-lifecycle-tests.log`). The initial added-close attempt correctly rejected a synthetic fixture lacking native writer files; the fixture now supplies its matching native files before asserting close.
- Tests use synthetic temporary roots only. Read-only source-home hashes are asserted by Engine integration fixtures.
- The existing 205-session native-space test covers RC1 codec materialization and reusable files. The warm-resource regression exercises RC2 inventory hooks. A separate RC2 official-host large-catalog acceptance is not claimed by these tests.

Logs are under `D:/AI/DeepSeekHarness-Plugin/artifacts/system-fixes-20260914`. Release packaging and copy deployment are separate from this functional commit.
