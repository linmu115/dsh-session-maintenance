import { createHash } from "node:crypto";
import type { CanonicalEventV1, LogicalSessionId, SessionVersionId } from "@linmu/dsh-session-contracts";
import { summarizeSessionEvents, NAMESPACE, WRITER_ID, supportsPluginVersion } from "@linmu/dsh-session-extension-gpt-compat";
import type { SqliteExtensionRepository } from "@linmu/dsh-session-store";

export type ExtensionVersionReader = (sessionId: LogicalSessionId, versionId: SessionVersionId) => Promise<readonly CanonicalEventV1[]>;
/** Rebuildable index of committed versions. No second writer to checkpoint/replay payloads. */
export async function synchronizeGptIndex(store: SqliteExtensionRepository, readVersion: ExtensionVersionReader) {
  for (const connection of store.connections().filter(c => c.namespace === NAMESPACE && c.configured && c.enabled && supportsPluginVersion(c.plugin_version))) {
    if (connection.writer_id !== WRITER_ID) throw new TypeError("GPT extension index writer differs");
    const scope = { instanceId: connection.instance_id, profileId: connection.profile_id, namespace: NAMESPACE };
    const sessions = store.database.prepare(`SELECT DISTINCT s.id,s.head_version_id,s.display_title
      FROM projection_sessions p JOIN projection_runs r ON r.id=p.run_id
      JOIN logical_sessions s ON s.id=p.logical_session_id
      WHERE r.instance_id=? AND r.profile_id=? AND s.head_version_id IS NOT NULL AND s.tombstoned_at IS NULL`)
      .all(scope.instanceId, scope.profileId) as {id: string; head_version_id: string; display_title: string}[];
    for (const session of sessions) {
      const objectId = `session-${createHash("sha256").update(session.id).digest("hex")}`;
      const old = store.get(scope, objectId);
      if (old && (old.content.body as {sourceVersion?:string}).sourceVersion === session.head_version_id && old.title === session.display_title) continue;
      const events = await readVersion(session.id as LogicalSessionId, session.head_version_id as SessionVersionId);
      const summary = summarizeSessionEvents(session.id, session.head_version_id, events);
      // Recheck the head after the asynchronous read; never publish an older version over a new head.
      if (store.database.prepare("SELECT head_version_id FROM logical_sessions WHERE id=?").get(session.id)?.head_version_id !== session.head_version_id) continue;
      if (!summary && !old) continue;
      store.write({ scope, objectId, writerId: WRITER_ID, expectedRevision: old?.revision ?? 0, deleted: summary === null,
        content: summary ? { schemaVersion: 1, title: session.display_title.slice(0, 500), body: summary,
          references: [{ logicalSessionId: session.id, sourceVersion: session.head_version_id }] } : old!.content });
    }
  }
}
