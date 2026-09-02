import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const [databaseValue, codexHomeValue] = process.argv.slice(2);
if (!databaseValue || !codexHomeValue) {
  throw new TypeError("usage: audit-codex-canonical-candidate.mjs <metadata.sqlite> <codex-home>");
}

const database = new DatabaseSync(resolve(databaseValue), { readOnly: true });
const codex = new DatabaseSync(resolve(codexHomeValue, "state_5.sqlite"), { readOnly: true });
const internalIds = new Set(
  codex.prepare("SELECT id, source, agent_role FROM threads").all()
    .filter((row) => {
      let source;
      try { source = JSON.parse(row.source); } catch { source = null; }
      return (source && typeof source === "object" && source.subagent) || row.agent_role !== null;
    })
    .map((row) => row.id),
);
const bindings = database.prepare(
  `SELECT b.logical_session_id, b.session_id
     FROM platform_bindings b
     JOIN logical_sessions s ON s.id = b.logical_session_id
    WHERE b.platform = 'codex' AND s.tombstoned_at IS NULL`,
).all();
const scalar = (sql, ...values) => Number(database.prepare(sql).get(...values).count);
const known = database.prepare(
  `SELECT b.session_id, s.display_title, p.name AS project_name, w.name AS workspace_name
     FROM platform_bindings b
     JOIN logical_sessions s ON s.id = b.logical_session_id
     LEFT JOIN project_memberships pm ON pm.logical_session_id = s.id
     LEFT JOIN logical_projects p ON p.id = pm.project_id
     LEFT JOIN workspace_memberships wm ON wm.logical_session_id = s.id
     LEFT JOIN logical_workspaces w ON w.id = wm.workspace_id
    WHERE b.platform = 'codex' AND b.session_id IN (?, ?)
    ORDER BY b.session_id`,
).all("01a03e27-ae05-78d2-8e31-14be2325f57b", "01a05ba0-c1fc-7d10-a1fc-2e04a25aaa8c");
const report = {
  activeSessions: scalar("SELECT COUNT(*) AS count FROM logical_sessions WHERE tombstoned_at IS NULL"),
  codexMirrors: scalar("SELECT COUNT(*) AS count FROM logical_sessions WHERE tombstoned_at IS NULL AND origin_kind = 'codex-mirror'"),
  maintenanceNative: scalar("SELECT COUNT(*) AS count FROM logical_sessions WHERE tombstoned_at IS NULL AND origin_kind = 'maintenance-native'"),
  importedInternalThreads: bindings.filter((row) => internalIds.has(row.session_id)).length,
  pollutedTitles: scalar(
    `SELECT COUNT(*) AS count FROM logical_sessions
      WHERE tombstoned_at IS NULL AND (
            display_title LIKE 'The following is the Codex agent history%'
         OR display_title LIKE '%APPROVAL REQUEST START%'
         OR display_title LIKE '%<codex_delegation>%'
         OR display_title LIKE '# Files mentioned by the user:%'
         OR display_title LIKE '# DSH continuation context%'
         OR display_title LIKE 'This block is automatically supplied ambient UI state%'
      )`,
  ),
  missingProjectMemberships: scalar(
    `SELECT COUNT(*) AS count FROM logical_sessions s
      LEFT JOIN project_memberships pm ON pm.logical_session_id = s.id
      WHERE s.tombstoned_at IS NULL AND pm.logical_session_id IS NULL`,
  ),
  missingWorkspaceMemberships: scalar(
    `SELECT COUNT(*) AS count FROM logical_sessions s
      LEFT JOIN workspace_memberships wm ON wm.logical_session_id = s.id
      WHERE s.tombstoned_at IS NULL AND wm.logical_session_id IS NULL`,
  ),
  toolCalls: scalar("SELECT COUNT(*) AS count FROM canonical_events WHERE kind = 'tool-call'"),
  toolResults: scalar("SELECT COUNT(*) AS count FROM canonical_events WHERE kind = 'tool-result'"),
  projectionRuns: database.prepare(
    `SELECT id, state, lease_id, instance_id, profile_id, started_at, heartbeat_at
       FROM projection_runs
      ORDER BY started_at DESC
      LIMIT 10`,
  ).all(),
  latestRunStatus: database.prepare(
    `SELECT run_id, sequence, at, stage, state, error_code, diagnostic_detail_ref, event_json
       FROM run_status_events
      ORDER BY at DESC, sequence DESC
      LIMIT 30`,
  ).all(),
  known,
};
database.close();
codex.close();
console.log(JSON.stringify(report, null, 2));
if (
  report.importedInternalThreads !== 0
  || report.pollutedTitles !== 0
  || report.missingProjectMemberships !== 0
  || report.missingWorkspaceMemberships !== 0
) process.exitCode = 1;
