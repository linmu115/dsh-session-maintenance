# DSH Alpha2 breaking changes handled

The Codec was built from the public npm artifacts for `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-session-persistence`, and `@deepseek-ai/dsh-session-persistence-jsonl` version `0.1.2-alpha.2`. No user session log was used as a fixture.

Compared with the pre-Alpha projection assumptions, Alpha2 requires:

- `SessionHeader.version` to use the harness-owned monotonic format number (`0` for Alpha2), not the package semver.
- Event `seq` values to be contiguous from zero; the persistence seam rejects gaps.
- The event log to remain the source of truth. User, assistant and tool surface entries retain the Alpha2 envelope and surface placement fields.
- Unknown event vocabulary to preserve its complete envelope. An unrecognized required event cannot be silently skipped; this Codec therefore stores the raw payload in canonical form and exposes a held-out diagnostic.
- Runtime capability detection to target `sessionPersistence` and its append/inspect semantics rather than the removed legacy Client Runtime APIs.

Runtime attachment and physical JSONL/Zstandard materialization are deliberately implemented by the projection lifecycle and Runtime Bridge in the next stage; this package is the pure, deterministic Codec boundary.
