# Adapter contract v1

Implement `DshSessionAdapterV1` with:

- `manifest`: interface major, package version, tested DSH evidence and declared
  capabilities;
- `probe`: inspect the supplied environment descriptor and report verified,
  compatible, experimental, or failed;
- `materialize`: write canonical workspaces/sessions through `ProjectionWriter`;
- `normalizeAppend`: convert one native append into canonical events;
- `inspect`: read a completed projection through `ProjectionReader`;
- `verify`: compare the materialization manifest and inspection;
- `resolveReference`: map a stable logical reference into the current run.

Adapters whose native event count can differ from the canonical storage-row
count should also implement `projectedNativeRevision(canonical, payload)`. It
must validate that `payload` starts with the exact native expansion of the
canonical session and return that prefix length. Session Maintenance uses this
value as the native durability watermark, including when repairing an older
run; it never assumes that one canonical row equals one native event.

Recovery-capable adapters may additionally implement
`recoverProjectionSession` to decode their adapter-owned metadata and committed
native prefix without exposing the native persistence layout to the Engine.

Adapters whose runtime writes restoration or preparation rows before a real
continuation may implement `shouldSupersedeRecoveryAppend(operation)`. This
hook is evaluated only for pending WAL records during crash recovery. Returning
`true` means the append contains no canonical user mutation; Session
Maintenance retains it as a superseded recovery artifact and records the
decision in the status log instead of creating a false session branch. The
hook must be deterministic and must return `false` whenever the append contains
any user, assistant, tool, or other durable continuation event.

Implement `DshRuntimeBridgeV1` with `attach`, `drain`, and `detach`. `detach` must
be safe after a successful attach even when drain fails.

All calls are DTO-based. Filesystem layout and transport are private to the
Adapter Host and are not part of this interface.
