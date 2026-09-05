# M06 — Retained identity and RC1 anchor resolution

## Scope

The r3 candidate exposed a real distinction: a successful session-format
check did not guarantee stable historical reference targets. Canonical IDs
were content-derived, and single native assistant IDs were lost by portable
projection. This follow-up fixes both without rewriting Codex or changing the
Obsidian reference protocol.

- `observeCodex` reuses an existing canonical ID when the complete platform,
  instance, source session and source event identity matches. Incoming content,
  digests and topology remain authoritative for the new immutable version.
  Parent-event references are rebound to retained IDs. Missing provenance is
  not guessed; duplicate sources and ID collisions fail explicitly.
- The same reconciliation applies to normal incremental import, not just the
  one-time migration. Re-importing unchanged corrected events is a no-op.
- RC1 preserves a single assistant message's native ID. Multi-source steps
  keep their existing native aggregation and obtain projection-local aliases
  from retained event/message IDs to the actual displayed message.
- Aliases live in the projection payload, not SessionEvents or model history.
  The Adapter receives an optional read-only projection reader through the
  existing reference interface. Engine opts into validation only for adapters
  declaring `verified-anchor-resolution` and does not parse native fields.
- An alias must lead to exactly one append-origin message in the selected
  logical/native session. Missing or ambiguous anchors return unavailable and
  record a failed `reference.roundtrip.verify` checkpoint. No fabricated tool
  message, payload replay or blind success is introduced.

RC1 Adapter 0.1.1 changes the cache fingerprint. The first subsequent launch
refreshes this format's cache; ordinary later launches retain delta reuse.
Session Maintenance entry package is 0.2.15, including the earlier M01–M06
conversation-mode and folded-card changes that were awaiting deployment.

## Focused checks

- RC1 package: 52 tests, including 13 anchor cases.
- Canonical engine: 19 tests, including source namespace separation,
  immutable previous versions, collision handling, corrected content,
  ordinary synchronization no-op and append identity.
- SDK: 3 tests; candidate migration/import: 7 tests; existing Alpha2 reference
  roundtrip: 1 test; new RC1 HTTP reference roundtrip: 1 test.
- Session Maintenance entry: 38 tests.
- Shared contracts, canonical engine, SDK, RC1 and Engine builds passed;
  Engine/RC1 typechecks passed. Checks are targeted to changed boundaries,
  following the operator's breakpoint-first strategy rather than a blanket
  unrelated integration run.

`scripts/verify-conversation-anchors.mjs` performs a repeatable read-only,
one-session-at-a-time comparison of source and candidate databases. No model
requests or browser actions are involved. The r4 audit passed:

| Check | Result |
| --- | ---: |
| Reconstructed sessions | 332 |
| Retained source occurrences with unchanged canonical ID | 41,040 |
| User/assistant message anchors with a valid target | 13,570 |
| Projection aliases with a real message target | 50,628 |
| Sampled real Adapter resolutions | 331 |

The one session without a user/assistant sample still passed projection and
alias validation. The prior two affected native DSH assistant IDs are covered
by the complete message-anchor check. Real external notebook clicks remain
operator acceptance; offline checks are not described as browser acceptance.

## Candidate and deployment

- Frozen plan: `ac2940188777cb5690db0d9b5286cccdd2b0a13e326e16666c403cd2f239bfcd`.
- Reviewed source: `11668d1f34bf3ecf9b176c6f8fecc1e508eaebbef944c0c03ca0899752d56a84`.
- Candidate: `metadata.conversation-repair-20260905-r4.sqlite`.
- Pre-activation file digest:
  `sha256:eb54abd2a9a7c5f3c87e2a9ce077f8176931605f1ec468ca4688439c2392335b`.
- Checkpoint: `checkpoint-m06-22c9c123-4406-4549-a49b-f1053b0d0a09`.
- RC1 materialization/inspection: 332/332 passed; SQLite integrity OK and zero
  foreign-key violations. No missing/changed prior versions, changed deleted
  session heads, or changed Maintenance-native heads in the pre-switch audit.
- Activation switched the configured Maintenance database after confirming no
  active writer, the unchanged source digest and the exact candidate digest.
- Only verified Maintenance Engine PID 46288 was stopped; replacement PID 7012
  became healthy on `http://127.0.0.1:1799`. The running registry reports RC1
  0.1.1 with verified-anchor resolution.
- RC1 `web` Profile installed `dsh-session-maintenance` 0.2.15 from the local
  package. Installed host/client bundle hashes match the source build. Profile
  manifest/lockfile differences concern only this dependency; Cordis config,
  workspace install policy and all other declared dependencies are unchanged.
- The previous entry and Profile manifests are saved under RC1 Home
  `profile-backups/maintenance-pre-0.2.15-20260905`. The old active database,
  old candidates and immutable objects remain available. No generation was
  built, no Codex source was changed, and no Launcher/model/compaction setting
  was edited.

DSH itself was not started and no user conversation was sent. The operator
can start the existing RC1 `web` instance and inspect conversation order,
historical deep links and a single ordinary send. Any failure is localized
through the existing lifecycle/receipt logs and the verified reference
checkpoint before adding more granular diagnostics.
