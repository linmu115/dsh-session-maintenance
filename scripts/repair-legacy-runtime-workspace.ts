import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { LogicalSessionId, RunId } from "@linmu/dsh-session-contracts";
import type { SessionMaintenanceEngine } from "../apps/engine/src/engine.js";
import { RuntimeWorkspaceRegistration } from "../apps/engine/src/runtime-workspace-registration.js";

/** Operator-only upgrade repair. Caller must verify the runtime exited and back up state first. */
export async function repairLegacyRuntimeWorkspace(engine: SessionMaintenanceEngine, runId: RunId, logicalSessionId: LogicalSessionId) {
  return engine.runWrite("session-maintenance", async () => {
    assert.equal(engine.runtimeBroker.isRunActive(runId), false, "Restart Maintenance before repairing a retained run");
    const run = await engine.projectionRunRepository.getProjectionRun(runId);
    assert.ok(run && run.state === "recovery-required", "Only an explicitly selected failed run can be repaired");
    const mapping = (await engine.projectionRunRepository.listProjectionSessions(runId)).find(item => item.logicalSessionId === logicalSessionId);
    assert.ok(mapping && mapping.mode === "maintenance-write" && mapping.lastCommittedOperationId === null);
    const snapshot = await engine.canonicalEngine.store.getSession(logicalSessionId);
    assert.ok(snapshot && snapshot.session.authorityScope === "maintenance" && snapshot.session.originKind === "maintenance-native");
    assert.equal(snapshot.session.tombstonedAt, null);
    assert.equal(snapshot.headVersionId, mapping.baseVersionId);
    assert.equal(logicalSessionId, `logical-dsh-${createHash("sha256").update(`${run.instanceId}\0${mapping.nativeSessionId}`).digest("hex").slice(0, 32)}`,
      "Session identity must match native registration");
    assert.ok(Date.parse(snapshot.session.createdAt) >= Date.parse(run.startedAt), "Pre-existing sessions cannot be reclassified");
    const version = await engine.canonicalEngine.store.getVersion(snapshot.headVersionId!);
    assert.ok(version && version.events.length === 0, "Cannot reclassify committed conversation history");
    const database = engine.repository.database;
    const membership = database.prepare("SELECT project_id FROM project_memberships WHERE logical_session_id=?").get(logicalSessionId);
    assert.ok(typeof membership?.project_id === "string", "Original project registration is required");
    const registration = new RuntimeWorkspaceRegistration(database);
    if (snapshot.workspaceId !== null) {
      const intent = database.prepare("SELECT workspace_id FROM runtime_workspace_registrations WHERE run_id=? AND native_session_id=?").get(runId, mapping.nativeSessionId);
      assert.equal(intent?.workspace_id, snapshot.workspaceId, "An existing workspace cannot be reassigned by this repair");
    }
    // Only an already joined Maintenance workspace can be reused here: a workspace the instance
    // created for itself is not enrolled by this repair.
    const workspaceId = registration.resolve({ run, nativeSessionId: mapping.nativeSessionId, projectId: membership.project_id as never });
    if (snapshot.workspaceId === null) await engine.sessionCommands.updateSession(logicalSessionId, { workspaceId });
    // The message bodies, head, WAL and run state remain for the normal provider recovery.
    assert.equal((await engine.canonicalEngine.store.getSession(logicalSessionId))?.headVersionId, snapshot.headVersionId);
    return { runId, logicalSessionId, workspaceId, canonicalHeadUnchanged: true };
  });
}
