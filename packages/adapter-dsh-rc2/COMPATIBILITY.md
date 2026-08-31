# Compatibility

| DSH environment | Adapter result | Evidence |
|---|---|---|
| `0.1.1-rc.2` with exact session package and `legacySessionPersistence` | verified | Synthetic RC2 Core Smoke and cross-version projection test |
| another `0.1.1-rc.*` build exposing the hook | compatible | Persistence shape matches; package set remains unverified |
| another version exposing the hook | experimental | Capability probe allows testing without semver lock |
| runtime without the hook | failed | No interpretable persistence contract exists |

Unknown event vocabulary is preserved and reported as `RC2_EVENT_HELD_OUT`.
