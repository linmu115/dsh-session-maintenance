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
  OperationId,
  ProjectionOperationReceipt,
  ProjectionRun,
  ProjectionRunRepository,
  ProjectionRunState,
  ProjectionSession,
  RunId,
  SessionVersionId,
} from "../../packages/contracts/src/index.js";
import { ProjectionLifecycle } from "../../packages/projection-lifecycle/src/index.js";
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

function canonicalEvent(logicalSessionId: LogicalSessionId, sequence: number, role: "user" | "assistant") {
  return {
    schemaVersion: 1 as const,
    id: `event-${sequence}`,
    logicalSessionId,
    sequence,
    kind: role === "user" ? "user-message" as const : "assistant-message" as const,
    role,
    content: { role, content: [{ type: "text", text: role === "user" ? "question" : "answer" }] },
    source: { platform: "dsh" as const, instanceId: "fixture", sessionId: "native", eventId: String(sequence), cursor: String(sequence + 1) },
    contentDigest: `sha256:${sequence}`,
    rawPayload: null,
    extensions: {},
  };
}

describe("Alpha2 projection append integration", () => {
  it("commits one assistant append into a new canonical version and replays without duplication", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-alpha2-append-"));
    roots.push(root);
    const logicalSessionId = "logical-alpha2-append" as LogicalSessionId;
    const canonicalStore = new MemoryCanonicalStore();
    const canonicalEngine = new CanonicalSessionEngine(canonicalStore);
    await canonicalEngine.appendDsh({
      logicalSessionId,
      title: "Alpha2 append",
      tags: ["fixture"],
      archivedAt: null,
      workspaceId: null,
      appendedEvents: [canonicalEvent(logicalSessionId, 0, "user")],
      observedAt: at,
      projection: {
        runId: "seed-run" as never,
        leaseId: "seed-lease" as never,
        branchId: "main" as never,
        adapterId: adapter.manifest.id,
        nativeSessionId: "seed-native" as never,
        operationId: "seed-operation" as never,
        nativeRevision: 1,
      },
    });
    const initial = canonicalStore.sessions.get(logicalSessionId)!;
    const initialVersion = canonicalStore.versions.get(initial.headVersionId!)!;
    const runRepository = new MemoryRuns();
    const statusAdapter = new MemoryStatusEventAdapter();
    let nextId = 0;
    const bridge = new Alpha2RuntimeBridge({
      attach: async () => ({ registrationId: "registration-alpha2-integration", attachedAt: at }),
      drain: async (_registrationId, runId) => ({ runId, pendingOperations: 0, receipts: [] }),
      detach: async () => undefined,
    });
    const lifecycle = new ProjectionLifecycle({
      runRepository,
      statusLog: new StatusLog(statusAdapter, { clock: () => at, idFactory: (kind) => `${kind}-${++nextId}` }),
      source: {
        load: async (run) => ({
          run,
          workspaces: [],
          sessions: [{ session: initial.session, events: initialVersion.events, workspaceId: null }],
        }),
      },
      adapter,
      bridge,
      canonicalEngine,
      runtimeRoot: join(root, "runtime"),
      clock: () => at,
      idFactory: (kind) => `${kind}-${++nextId}`,
    });
    const handle = await lifecycle.openRun({
      instanceId: "alpha2-integration",
      profileId: "alpha2-stable",
      dshVersion: "0.1.2-alpha.2",
      branchId: "main" as never,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    });
    const operation = {
      runId: handle.run.id,
      operationId: "operation-alpha2-answer" as OperationId,
      nativeSessionId: alpha2NativeSessionId(logicalSessionId),
      nativeRevision: 2,
      observedAt: "2026-08-31T00:00:01.000Z",
      payload: {
        logicalSessionId,
        baseVersionId: initial.headVersionId,
        events: [{
          type: "assistant/message",
          seq: 1,
          time: 1,
          data: { turn: 0, step: 0, message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
        }],
      },
    } as const;

    const first = await bridge.submitAppend(operation);
    const second = await lifecycle.append(handle, operation);
    expect(second).toEqual(first);
    expect(canonicalStore.mutations.filter((mutation) => mutation.operationId === operation.operationId)).toHaveLength(1);
    const committedVersion = canonicalStore.versions.get(first.canonicalVersionId!)!;
    expect(committedVersion.events.map((event) => `${event.sequence}:${event.role}`)).toEqual(["0:user", "1:assistant"]);
    expect((await statusAdapter.list({ operationId: operation.operationId, stage: "session.append.commit", limit: 20 })).items.map((event) => event.state)).toEqual([
      "started",
      "succeeded",
    ]);
  });
});
