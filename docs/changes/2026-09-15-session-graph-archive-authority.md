# Session graph archive authority

Archiving a canonical session now revokes every active upstream reference whose source or target is that logical session, across all instance/profile scopes. Reference revocation and graph updates do not depend on extension availability or an open canvas. A failed graph lifecycle write rolls back the associated canonical metadata change.

The owner's graph is retained with `graph.archivedAt` and an extension-object soft deletion. Ordinary graph lists omit it; an already-open canvas can load its archived snapshot and show a read-only state. Ensuring, editing or starting an archived owner and reading archived session context are rejected. Restoring a session restores only a graph previously archived by this lifecycle; independently deleted graphs remain deleted. Revoked references and removed graph edges are never restored automatically. Pending placeholder connections incident to an archived session card are also removed across scopes; card positions and unrelated placeholder connections remain intact.

The canonical store receives an optional synchronous archive-change callback, executed inside its commit transaction. Composition connects that callback to the graph domain and reconciles pre-existing archive states at startup. Maintenance metadata commands invoke the same domain inside their transaction. DSH 0.1.5-rc.2 keeps its native archive state in the workspace registry rather than session events; the runtime host bridge uses the current-run `set-session-archived` endpoint. Later native message tails read the current canonical archive state instead of reapplying the stale state captured when the instance started.

The source-marker removal endpoint validates the current source native session and its logical identity before revoking the selected reference. It updates every graph using that reference in the same instance/profile and preserves unrelated references. Repeated deletion returns the same revoked state without extra graph revisions.

New interfaces:

- `POST /v1/session-graph/revoke-source`: `{ runId, nativeSessionId, referenceId }`; returns the revoked `SessionContextRecord`.
- `POST /v1/session-graph/set-session-archived`: `{ runId, nativeSessionId, archived }`; returns `{ logicalSessionId, archived }`.
- `POST /v1/session-context/status`: `{ runId, targetNativeSessionId, referenceId }`; returns `{ referenceId, state }`. The target identity is checked even for revoked or archived records. Missing objects and incorrect identities remain errors, never inferred deletions.
- Host methods: `maintenanceGraph.revokeSource`, `maintenanceGraph.setSessionArchived`, `maintenanceSessionContext.status`.
- Sticker host dispatch: `maintenance-knowledge/api/revoke-source-reference`.

Validation used synthetic databases and RC2 runtime sessions only. Nine focused test files passed (35 tests), including real authenticated HTTP operations, duplicate archive/delete requests, cross-scope revocation with no configured plugins, archive/restore, stale saved graph rejection, source identity rejection, an in-flight model tail after archive, canonical rollback after an injected graph-write failure, and direct canonical commits without a UI request. Contracts, canonical engine, store and projection lifecycle builds plus Engine type checking passed. Source-home hashes remained unchanged; no real model request was sent.

The follow-up pending-edge check reran the graph-domain and authenticated archive suites (18 tests). The added fixture covers incoming and outgoing placeholder connections in two instance/profile scopes, stable card positions, unrelated draft connections, stale-save rejection, and archive/restore retries without recreating edges or reference records.
