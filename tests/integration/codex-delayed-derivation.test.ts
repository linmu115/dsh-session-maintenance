import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { adapter, alpha2NativeSessionId, Alpha2RuntimeBridge } from "../../packages/adapter-dsh-alpha2/src/index.js";
import {
  CanonicalSessionEngine,
  type CanonicalEngineMutation,
  type CanonicalEngineReceipt,
  type CanonicalSessionEngineStore,
  type CanonicalSessionSnapshot,
  type CanonicalVersionRecord,
  type CodexObservationRecord,
} from "../../packages/canonical-session-engine/src/index.js";
import type {
  LogicalSessionId,
  LogicalWorkspaceId,
  OperationId,
  ProjectionOperationReceipt,
  ProjectionRun,
  ProjectionRunRepository,
  ProjectionRunState,
  ProjectionSession,
  RunId,
  SessionVersionId,
} from "../../packages/contracts/src/index.js";
import { JsonProjectionDirectory, ProjectionLifecycle } from "../../packages/projection-lifecycle/src/index.js";
import { MemoryStatusEventAdapter, StatusLog } from "../../packages/session-status-log/src/index.js";

const roots: string[] = [];
const at = "2026-08-31T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryCanonicalStore implements CanonicalSessionEngineStore {
  readonly sessions = new Map<string, CanonicalSessionSnapshot>();
  readonly versions = new Map<string, CanonicalVersionRecord>();
  readonly receipts = new Map<string, CanonicalEngineReceipt>();
  readonly mutations: CanonicalEngineMutation[] = [];
  async getSession(id: LogicalSessionId) { return this.sessions.get(id); }
  async getVersion(id: SessionVersionId) { return this.versions.get(id); }
  async getOperationReceipt(id: OperationId) { return this.receipts.get(id); }
  async recordCodexObservation(_input: CodexObservationRecord) {}
  async commit(input: CanonicalEngineMutation) {
    this.mutations.push(input);
    if (input.version !== null) this.versions.set(input.version.id, input.version);
    this.sessions.set(input.session.id, {
      session: input.session,
      headVersionId: input.version?.id ?? input.session.headVersionId,
      workspaceId: input.membership?.workspaceId ?? null,
      membershipRevision: input.membership?.revision ?? 0,
      tombstone: input.tombstone,
    });
    if (input.receipt.operationId !== null) this.receipts.set(input.receipt.operationId, input.receipt);
    return input.receipt;
  }
}

class MemoryRuns implements ProjectionRunRepository {
  readonly runs = new Map<string, ProjectionRun>();
  readonly sessions = new Map<string, ProjectionSession>();
  readonly receipts = new Map<string, ProjectionOperationReceipt>();
  async createProjectionRun(input: ProjectionRun) { this.runs.set(input.id, input); return input; }
  async getProjectionRun(id: RunId) { return this.runs.get(id); }
  async setProjectionRunState(id: RunId, state: ProjectionRunState) {
    const run = this.runs.get(id);
    if (run === undefined) throw new Error("run not found");
    this.runs.set(id, { ...run, state });
  }
  async upsertProjectionSession(input: ProjectionSession) { this.sessions.set(`${input.runId}:${input.nativeSessionId}`, input); }
  async saveOperationReceipt(input: ProjectionOperationReceipt) { this.receipts.set(input.operationId, input); }
  async getOperationReceipt(id: OperationId) { return this.receipts.get(id); }
}

function codexEvent(logicalSessionId: LogicalSessionId, sequence: number, text: string) {
  return {
    schemaVersion: 1 as const,
    id: `codex-${sequence}`,
    logicalSessionId,
    sequence,
    kind: sequence % 2 === 0 ? "user-message" as const : "assistant-message" as const,
    role: sequence % 2 === 0 ? "user" as const : "assistant" as const,
    content: { role: sequence % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text }] },
    source: { platform: "codex" as const, instanceId: "codex", sessionId: "codex-source", eventId: String(sequence), cursor: String(sequence) },
    contentDigest: `sha256:codex-${sequence}`,
    rawPayload: null,
    extensions: {},
  };
}

describe("Codex delayed derivation integration", () => {
  it("keeps the projected base fixed and switches the native mapping only after the first append", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-codex-derivation-"));
    roots.push(root);
    const sourceId = "logical-codex-projected" as LogicalSessionId;
    const workspaceId = "workspace-projected" as LogicalWorkspaceId;
    const canonicalStore = new MemoryCanonicalStore();
    const canonicalEngine = new CanonicalSessionEngine(canonicalStore);
    const base = await canonicalEngine.observeCodex({
      logicalSessionId: sourceId,
      title: "Projected Codex task",
      tags: ["codex"],
      archivedAt: null,
      workspaceId,
      events: [codexEvent(sourceId, 0, "question")],
      sourceCursor: "cursor-1",
      observedAt: at,
    });
    const projectedSnapshot = canonicalStore.sessions.get(sourceId)!;
    const projectedVersion = canonicalStore.versions.get(base.versionId!)!;
    const runs = new MemoryRuns();
    const statuses = new MemoryStatusEventAdapter();
    let nextId = 0;
    const bridge = new Alpha2RuntimeBridge({
      attach: async () => ({ registrationId: "registration-codex-derived", attachedAt: at }),
      drain: async (_registrationId, runId) => ({ runId, pendingOperations: 0, receipts: [] }),
      detach: async () => undefined,
    });
    const lifecycle = new ProjectionLifecycle({
      runRepository: runs,
      statusLog: new StatusLog(statuses, { clock: () => at, idFactory: (kind) => `${kind}-${++nextId}` }),
      source: { load: async (run) => ({
        run,
        workspaces: [{
          schemaVersion: 1,
          id: workspaceId,
          parentId: null,
          name: "Projected",
          sortKey: "0001",
          deletedAt: null,
          createdAt: at,
          updatedAt: at,
        }],
        sessions: [{ session: projectedSnapshot.session, events: projectedVersion.events, workspaceId }],
      }) },
      adapter,
      bridge,
      canonicalEngine,
      runtimeRoot: join(root, "runtime"),
      clock: () => at,
      idFactory: (kind) => `${kind}-${++nextId}`,
    });
    const handle = await lifecycle.openRun({
      instanceId: "alpha2-codex",
      profileId: "alpha2",
      dshVersion: "0.1.2-alpha.2",
      branchId: "main" as never,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    });
    expect(canonicalStore.sessions).toHaveLength(1);

    const codexAdvanced = await canonicalEngine.observeCodex({
      logicalSessionId: sourceId,
      title: "Codex advanced after projection",
      tags: ["codex", "later"],
      archivedAt: null,
      workspaceId: "workspace-later" as LogicalWorkspaceId,
      events: [codexEvent(sourceId, 0, "question"), codexEvent(sourceId, 1, "Codex answer")],
      sourceCursor: "cursor-2",
      observedAt: "2026-08-31T00:01:00.000Z",
    });
    const operation = {
      runId: handle.run.id,
      operationId: "operation-first-dsh-write" as OperationId,
      nativeSessionId: alpha2NativeSessionId(sourceId),
      nativeRevision: 2,
      observedAt: "2026-08-31T00:02:00.000Z",
      payload: {
        logicalSessionId: sourceId,
        baseVersionId: base.versionId,
        events: [{ type: "assistant/message", seq: 1, time: 1, data: { turn: 0, step: 0, message: { role: "assistant", content: [{ type: "text", text: "DSH answer" }] } } }],
      },
    } as const;
    const receipt = await bridge.submitAppend(operation);
    const replay = await bridge.submitAppend(operation);
    expect(replay).toEqual(receipt);
    expect(receipt.logicalSessionId).not.toBe(sourceId);
    expect(canonicalStore.sessions.get(sourceId)?.headVersionId).toBe(codexAdvanced.versionId);
    expect(canonicalStore.sessions.get(sourceId)?.session.authorityScope).toBe("codex");
    expect(canonicalStore.sessions.get(receipt.logicalSessionId)).toMatchObject({
      session: { authorityScope: "maintenance", originKind: "codex-derived", title: "Projected Codex task" },
      workspaceId,
    });
    expect(runs.sessions.get(`${handle.run.id}:${operation.nativeSessionId}`)).toMatchObject({
      logicalSessionId: receipt.logicalSessionId,
      mode: "maintenance-write",
      derivedChildSessionId: receipt.logicalSessionId,
      baseVersionId: receipt.canonicalVersionId,
    });
    expect(await new JsonProjectionDirectory(handle.projectionRoot).readSession(operation.nativeSessionId)).toMatchObject({
      logicalSessionId: receipt.logicalSessionId,
      baseVersionId: receipt.canonicalVersionId,
    });
    expect((await statuses.list({ operationId: operation.operationId, stage: "session.derivation.create", limit: 20 })).items.map((event) => event.state)).toEqual([
      "started",
      "succeeded",
    ]);
  });
});
