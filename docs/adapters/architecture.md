# Architecture and trust boundary

Maintenance owns canonical sessions. An Adapter is a replaceable codec for one
DSH storage/runtime shape. It receives typed DTOs, a temporary projection root,
and a controlled Runtime Bridge endpoint.

An Adapter must not:

- open, query, copy, migrate, or mutate the Maintenance SQLite database;
- read a Codex home;
- choose logical session identity;
- create global deletion tombstones;
- treat a native DSH session or workspace ID as canonical identity.

Core owns leases, operation idempotency, canonical commits, tombstones,
checkpoints, status logs, and Adapter selection. The Adapter owns probe,
materialization, native-append normalization, inspection, digest verification,
and stable-reference resolution inside its temporary projection.
