import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { materializeAlpha2 } from "../packages/adapter-dsh-alpha2/dist/index.js";
import { ZstdContentObjectStore } from "../packages/session-store/dist/index.js";

const [databasePath, dshSessionEntry, maximumValue] = process.argv.slice(2);
if (!databasePath || !dshSessionEntry) {
  throw new TypeError("usage: validate-current-alpha2-replay.mjs <metadata.sqlite> <dsh-session/index.js> [maximum]");
}
const maximum = maximumValue === undefined ? Number.POSITIVE_INFINITY : Number.parseInt(maximumValue, 10);
if (!(maximum > 0)) throw new TypeError("maximum must be positive");

const { Session } = await import(pathToFileURL(dshSessionEntry).href);
const database = new DatabaseSync(databasePath, { readOnly: true });
const objectStore = new ZstdContentObjectStore(dirname(resolve(databasePath)));
const rows = database.prepare(
  `SELECT s.id, s.display_title, s.labels_json, s.authority_scope, s.origin_kind,
          s.head_version_id, s.archived_at, s.tombstoned_at, s.created_at, s.updated_at,
          m.workspace_id,
          p.id AS project_id,
          p.name AS project_name,
          (SELECT r.root_path
             FROM project_roots r
            WHERE r.project_id = p.id
            ORDER BY r.ordinal, r.normalized_root_path
            LIMIT 1) AS project_root
     FROM logical_sessions s
     LEFT JOIN workspace_memberships m ON m.logical_session_id = s.id
     LEFT JOIN project_memberships pm ON pm.logical_session_id = s.id
     LEFT JOIN logical_projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
    WHERE s.authority_scope IS NOT NULL
      AND s.origin_kind IS NOT NULL
      AND s.updated_at IS NOT NULL
      AND s.tombstoned_at IS NULL
    ORDER BY s.updated_at DESC, s.id
    LIMIT ?`,
).all(Number.isFinite(maximum) ? maximum : 2_147_483_647);

const eventStatement = database.prepare(
  "SELECT event_json FROM canonical_events WHERE logical_session_id = ? ORDER BY sequence",
);
const versionStatement = database.prepare(
  "SELECT body_object FROM session_versions WHERE id = ? AND logical_session_id = ?",
);
const failures = [];
let validated = 0;
for (const row of rows) {
  let events;
  if (row.head_version_id !== null) {
    const version = versionStatement.get(row.head_version_id, row.id);
    if (version === undefined) throw new Error(`missing replay head: ${row.id}/${row.head_version_id}`);
    const body = JSON.parse(Buffer.from(await objectStore.get(version.body_object)).toString("utf8"));
    if (body.schemaVersion !== 1 || !Array.isArray(body.events)) {
      throw new Error(`invalid replay body: ${row.id}/${row.head_version_id}`);
    }
    events = body.events;
  } else {
    events = eventStatement.all(row.id).map(({ event_json: eventJson }) => JSON.parse(eventJson));
  }
  let payload;
  await materializeAlpha2({
    run: {
      schemaVersion: 1,
      id: "run-replay-validation",
      leaseId: "lease-replay-validation",
      branchId: "main",
      instanceId: "validation",
      profileId: "validation",
      dshVersion: "0.1.2-alpha.2",
      adapterId: "dsh-alpha2",
      state: "preparing",
      startedAt: row.created_at,
      heartbeatAt: row.updated_at,
      checkpointId: null,
    },
    workspaces: [],
    sessions: [{
      session: {
        schemaVersion: 1,
        id: row.id,
        authorityScope: row.authority_scope,
        originKind: row.origin_kind,
        headVersionId: row.head_version_id,
        title: row.display_title,
        tags: JSON.parse(row.labels_json),
        archivedAt: row.archived_at,
        tombstonedAt: row.tombstoned_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      events,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      projectName: row.project_name,
      projectRoot: row.project_root,
    }],
  }, {
    writeWorkspace: async () => undefined,
    writeSession: async (_id, value) => { payload = value; },
  });
  try {
    Session.create(payload.header.id, payload.events, payload.header);
    validated += 1;
  } catch (error) {
    failures.push({
      logicalSessionId: row.id,
      title: row.display_title,
      eventCount: events.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
database.close();

console.log(JSON.stringify({ scanned: rows.length, validated, failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;
