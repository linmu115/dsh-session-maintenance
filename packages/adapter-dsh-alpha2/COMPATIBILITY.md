# Compatibility

| DSH environment | Adapter result | Evidence |
|---|---|---|
| `0.1.2-alpha.2` with exact `dsh-session` and `dsh-session-persistence` packages | verified | Synthetic Core Smoke based on public npm type and storage contracts |
| another `0.1.2-alpha.*` build exposing `sessionPersistence` | compatible | Runtime shape matches; exact package set remains visible as unverified |
| another version exposing `sessionPersistence` | experimental | Capability probe permits testing; no semver hard block |
| runtime without `sessionPersistence` | failed | Required persistence seam is absent |

The manifest declares `*` rather than pinning a DSH version. `testedDshVersions` records exact evidence without preventing future experimental combinations.

Unknown plugin event types are preserved verbatim and returned as `ALPHA2_EVENT_HELD_OUT`. This is a visibility signal, not data loss and not an automatic compatibility refusal.
