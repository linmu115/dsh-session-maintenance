# M03 — Codex Leading-space Entity Normalization

## Diagnosis

Read-only inspection of current Codex rollout files proved that affected user
messages already contain the literal prefix `&#x20;` in the Codex source text.
The RC1 Adapter and DSH renderer were not introducing a second encoding step;
they were faithfully displaying this Codex Desktop transport artifact.

The same source files also contain intentional entity strings inside quoted
diagnostics, code and user explanations. A general HTML decoder would therefore
change legitimate conversation content.

## Change

The Codex Read Adapter now removes only one precisely bounded artifact:

- one or more literal `&#x20;` prefixes at the start of a visible Codex user
  message, allowing surrounding leading whitespace;
- matching is case-insensitive and accepts zero-padded hexadecimal spelling;
- entities elsewhere in the message are preserved byte-for-byte;
- no other named, decimal or hexadecimal entity is decoded.

The Adapter records a source-local normalization marker, and the existing
`codex.classification` breakpoint reports only the count of affected messages.
The marker and raw Codex source are not widened into model-facing Canonical
content.

## Boundaries

- Codex source files remain read-only and unchanged.
- No global HTML decoding or Markdown rewriting was added.
- No existing Canonical version, DSH projection or live profile is migrated in
  M03.
- M06 remains the only stage allowed to replace active imported heads.

## Focused verification

- an encoded leading-space prefix is removed;
- the same entity in the middle of a message is preserved;
- `&lt;...&gt;` and `&amp;` remain literal;
- the classification breakpoint reports exactly one normalized event.

All modification tests use synthetic Codex fixture homes.
