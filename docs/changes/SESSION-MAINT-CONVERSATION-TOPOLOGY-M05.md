# M05 — Folded Unknown-record Regions

## Outcome

The RC1 projection no longer emits one visible Maintenance card for every
genuine MCSF `other` row. It now emits at most:

- one folded card for all `other` rows inside the same Canonical turn; and
- one folded card for each contiguous `other` region outside a turn.

The grouped projection keeps count, Canonical sequence bounds, source kinds,
portable summaries and Adapter evidence references. It does not copy raw
source payloads into the DSH log.

The DSH client card uses a native `<details>` disclosure and is closed by
default. Its summary stays compact; expanding it lists the individual labels
and source kinds.

## Known internal records

Codex lifecycle, turn context, presentation duplicates, token usage, world
state and compaction boundaries were already classified as evidence-only by
the M02 Codex Read Adapter. M05 does not recreate them as Canonical `other`
rows and does not add RC1-specific source-kind guesses. Existing old heads are
unchanged until M06 rebuilds them from the read-only Codex source.

Only a record that the Codex Adapter still classifies as genuinely unknown can
enter an `other` group.

## Safety boundary

- grouped cards use `maintenance/other` with `ignorable: true`;
- they have no `surfaceOp` and are never `tool/result`;
- they cannot enter model history;
- no native tool call or tool result is manufactured;
- grouping changes presentation only, not Canonical evidence ownership;
- no live profile or existing Canonical head is modified in M05.

## Focused verification

- two unknown rows separated by normal events in one turn become one card;
- a later contiguous outside-turn region becomes one separate card;
- both cards are log-only and satisfy the RC1 lifecycle inspector;
- the client decodes every grouped item and renders a closed disclosure;
- all RC1 Adapter and Session Maintenance plugin tests pass.

All fixtures are synthetic.
