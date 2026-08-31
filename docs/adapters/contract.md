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

Implement `DshRuntimeBridgeV1` with `attach`, `drain`, and `detach`. `detach` must
be safe after a successful attach even when drain fails.

All calls are DTO-based. Filesystem layout and transport are private to the
Adapter Host and are not part of this interface.
