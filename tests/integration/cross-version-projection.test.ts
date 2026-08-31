import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { OperationId, ProjectionOperationReceipt, ProjectionRun, ProjectionRunRepository, ProjectionRunState, ProjectionSession, RunId } from "@linmu/dsh-session-contracts";

import { adapter as alpha2Adapter } from "../../packages/adapter-dsh-alpha2/src/index.js";
import { adapter as rc2Adapter } from "../../packages/adapter-dsh-rc2/src/index.js";
import { logicalProjectionDigest } from "../../packages/session-adapter-sdk/src/index.js";
import { ProjectionLifecycle } from "../../packages/projection-lifecycle/src/index.js";
import { MemoryStatusEventAdapter, StatusLog } from "../../packages/session-status-log/src/index.js";

const roots: string[] = [];
const at = "2026-08-31T00:00:00.000Z";
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class MemoryRuns implements ProjectionRunRepository {
  readonly runs = new Map<string, ProjectionRun>();
  readonly sessions = new Map<string, ProjectionSession>();
  async createProjectionRun(input: ProjectionRun) { this.runs.set(input.id, input); return input; }
  async getProjectionRun(id: RunId) { return this.runs.get(id); }
  async setProjectionRunState(id: RunId, state: ProjectionRunState) { this.runs.set(id, { ...this.runs.get(id)!, state }); }
  async setProjectionRunCheckpoint(id: RunId, checkpointId: string) { this.runs.set(id, { ...this.runs.get(id)!, checkpointId: checkpointId as never }); }
  async listProjectionSessions(runId: RunId) { return [...this.sessions.values()].filter((session) => session.runId === runId); }
  async upsertProjectionSession(input: ProjectionSession) { this.sessions.set(`${input.runId}:${input.nativeSessionId}`, input); }
  async saveOperationReceipt(_input: ProjectionOperationReceipt) {}
  async getOperationReceipt(_id: OperationId) { return undefined; }
}

function projection(run: ProjectionRun) {
  const logicalSessionId = "logical-cross-version" as never;
  return {
    run,
    workspaces: [{ schemaVersion: 1 as const, id: "workspace-cross-version" as never, parentId: null, name: "跨版本", sortKey: "a", deletedAt: null, createdAt: at, updatedAt: at }],
    sessions: [{ session: { schemaVersion: 1 as const, id: logicalSessionId, authorityScope: "maintenance" as const, originKind: "maintenance-native" as const, headVersionId: "version-cross-version" as never, title: "同一逻辑会话", tags: ["reference"], archivedAt: null, tombstonedAt: null, createdAt: at, updatedAt: at }, events: [{ schemaVersion: 1 as const, id: "anchor-cross-version", logicalSessionId, sequence: 0, kind: "obsidian-reference" as const, role: "system" as const, content: { referenceId: "reference-cross-version" }, source: { platform: "dsh" as const, instanceId: "fixture", sessionId: "source", eventId: "0", cursor: "0" }, contentDigest: "sha256:reference-cross-version", rawPayload: null, extensions: {} }], workspaceId: "workspace-cross-version" as never }],
  };
}

function bridge(adapterId: string, calls: string[]) {
  return {
    attach: async (context: { readonly run: ProjectionRun }) => { calls.push(`attach:${adapterId}`); return { runId: context.run.id, adapterId: adapterId as never, attachedAt: at }; },
    drain: async (handle: { readonly runId: RunId }) => { calls.push(`drain:${adapterId}`); return { runId: handle.runId, pendingOperations: 0, receipts: [] }; },
    detach: async () => { calls.push(`detach:${adapterId}`); },
  };
}

describe("cross-version canonical projection", () => {
  it("closes Alpha2 then opens RC2 with the same logical workspace, version and reference digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-cross-version-")); roots.push(root);
    const runtimeRoot = join(root, "maintenance-runtime");
    const profileHome = join(root, "launcher-profile"); await mkdir(profileHome);
    const runs = new MemoryRuns();
    const statusAdapter = new MemoryStatusEventAdapter();
    let sequence = 0;
    const statusLog = new StatusLog(statusAdapter, { clock: () => at, idFactory: (kind) => `${kind}-${++sequence}` });
    const calls: string[] = [];
    const make = (adapter: typeof alpha2Adapter | typeof rc2Adapter) => new ProjectionLifecycle({ runRepository: runs, statusLog, source: { load: async (run) => projection(run) }, adapter, bridge: bridge(adapter.manifest.id, calls), checkpointRepository: { saveCheckpoint: async () => undefined }, runtimeRoot, clock: () => at, idFactory: (kind) => `${kind}-${++sequence}` });

    const alphaLifecycle = make(alpha2Adapter);
    const alpha = await alphaLifecycle.openRun({ instanceId: "alpha2", profileId: "alpha2", dshVersion: "0.1.2-alpha.2", branchId: "main" as never, maintenanceEndpoint: "http://127.0.0.1:41781" });
    const alphaLogicalDigest = logicalProjectionDigest(projection(alpha.run));
    const alphaReference = await alpha2Adapter.resolveReference({ logicalSessionId: "logical-cross-version" as never, logicalAnchorId: "anchor-cross-version", legacyNativeSessionId: null }, alpha.run);
    await alphaLifecycle.closeRun(alpha);

    const rcLifecycle = make(rc2Adapter);
    const rc = await rcLifecycle.openRun({ instanceId: "rc2", profileId: "rc2", dshVersion: "0.1.1-rc.2", branchId: "main" as never, maintenanceEndpoint: "http://127.0.0.1:41781" });
    const rcLogicalDigest = logicalProjectionDigest(projection(rc.run));
    const rcReference = await rc2Adapter.resolveReference({ logicalSessionId: "logical-cross-version" as never, logicalAnchorId: "anchor-cross-version", legacyNativeSessionId: null }, rc.run);
    const p6 = await statusLog.start({ runId: rc.run.id, leaseId: rc.run.leaseId, profileId: rc.run.profileId, adapterId: rc.run.adapterId, dshVersion: rc.run.dshVersion, stage: "projection.cross-version.verify", logicalSessionId: null, nativeSessionId: null, operationId: null, diagnosticDetailRef: `diag:p6-${alpha.run.id}-${rc.run.id}-${rcLogicalDigest.slice(7)}` });
    expect(rcLogicalDigest).toBe(alphaLogicalDigest);
    expect(projection(rc.run).workspaces).toEqual(projection(alpha.run).workspaces);
    expect(projection(rc.run).sessions[0]?.session.headVersionId).toBe(projection(alpha.run).sessions[0]?.session.headVersionId);
    expect({ logicalSessionId: rcReference.logicalSessionId, nativeAnchorId: rcReference.nativeAnchorId, status: rcReference.status }).toEqual({ logicalSessionId: alphaReference.logicalSessionId, nativeAnchorId: alphaReference.nativeAnchorId, status: alphaReference.status });
    await statusLog.succeed(p6, { diagnosticDetailRef: `diag:p6-${alpha.run.id}-${rc.run.id}-${rcLogicalDigest.slice(7)}` });
    await rcLifecycle.closeRun(rc);

    expect(await readdir(profileHome)).toEqual([]);
    expect(calls).toEqual(["attach:dsh-alpha2", "drain:dsh-alpha2", "drain:dsh-alpha2", "detach:dsh-alpha2", "attach:dsh-rc2", "drain:dsh-rc2", "drain:dsh-rc2", "detach:dsh-rc2"]);
    expect((await statusAdapter.list({ stage: "projection.cross-version.verify", limit: 10 })).items.map((event) => event.state)).toEqual(["started", "succeeded"]);
  });
});
