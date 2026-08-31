# Capabilities

Capabilities are evidence-backed features, not permissions. Core still applies
its own safety checks.

- `session-persistence`: can attach DSH to the temporary projection.
- `append`, `revision-check`, `read-from`, `borrow-session`, `snapshots`: native
  session I/O features.
- `workspace-projection`: projects the logical workspace tree.
- `annotation`, `sticker-obsidian-reference`: preserves cross-plugin records.
- `unknown-event-round-trip`: retains payloads the Adapter cannot interpret.
- `stable-native-session-id`, `metadata-hot-update`: native behavior.
- `deep-link-resolution`: resolves logical references for the active run.
- `recovery`, `projection-verification`: supports replay and digest checks.

Do not declare a capability because an API symbol exists. Probe it or provide a
fixture-backed verification result.
