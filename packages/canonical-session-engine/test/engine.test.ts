import { describe, expect, it } from "vitest";
import type {
  AdapterId,
  BranchId,
  CheckpointId,
  LeaseId,
  LogicalSessionId,
  LogicalWorkspaceId,
  NativeSessionId,
  OperationId,
  RunId,
  SessionVersionId,
} from "@linmu/dsh-session-contracts";

import {
  CanonicalSessionEngine,
  type CanonicalEngineMutation,
  type CanonicalEngineReceipt,
  type CanonicalSessionEngineStore,
  type CanonicalSessionSnapshot,
  type CanonicalVersionRecord,
  type CodexObservationRecord,
} from "../src/index.js";

const at = "2026-08-31T00:00:00.000Z";

class MemoryEngineStore implements CanonicalSessionEngineStore {
  readonly sessions = new Map<string, CanonicalSessionSnapshot>();
  readonly versions = new Map<string, CanonicalVersionRecord>();
  readonly receipts = new Map<string, CanonicalEngineReceipt>();
  readonly observations: CodexObservationRecord[] = [];
  readonly mutations: CanonicalEngineMutation[] = [];

  async getSession(id: LogicalSessionId): Promise<CanonicalSessionSnapshot | undefined> {
    return this.sessions.get(id);
  }

  async getVersion(id: SessionVersionId): Promise<CanonicalVersionRecord | undefined> {
    return this.versions.get(id);
  }

  async getOperationReceipt(operationId: OperationId): Promise<CanonicalEngineReceipt | undefined> {
    return this.receipts.get(operationId);
  }

  async recordCodexObservation(input: CodexObservationRecord): Promise<void> {
    this.observations.push(input);
  }

  async commit(input: CanonicalEngineMutation): Promise<CanonicalEngineReceipt> {
    this.mutations.push(input);
    if (input.version !== null) this.versions.set(input.version.id, input.version);
    this.sessions.set(input.session.id, {
      session: input.session,
      headVersionId: input.version?.id ?? input.session.headVersionId,
      workspaceId: input.membership?.workspaceId ?? null,
      membershipRevision: input.membership?.revision ?? 0,
      tombstone: input.tombstone,
    });
    if (input.receipt.operationId !== null) {
      this.receipts.set(input.receipt.operationId, input.receipt);
    }
    return input.receipt;
  }
}

function event(
  logicalSessionId: LogicalSessionId,
  id: string,
  sequence: number,
  text: string,
  platform: "codex" | "dsh" = "codex",
) {
  return {
    schemaVersion: 1 as const,
    id,
    logicalSessionId,
    sequence,
    kind: sequence % 2 === 0 ? "user-message" as const : "assistant-message" as const,
    role: sequence % 2 === 0 ? "user" as const : "assistant" as const,
    content: { text },
    source: {
      platform,
      instanceId: `${platform}-fixture`,
      sessionId: `${platform}-session`,
      eventId: id,
      cursor: String(sequence),
    },
    contentDigest: `sha256:${id}`,
    rawPayload: null,
    extensions: {},
  };
}

function projection(operationId: string) {
  return {
    runId: "run-alpha2" as RunId,
    leaseId: "lease-alpha2" as LeaseId,
    branchId: "main" as BranchId,
    adapterId: "adapter-alpha2" as AdapterId,
    nativeSessionId: "native-alpha2" as NativeSessionId,
    operationId: operationId as OperationId,
    nativeRevision: 1,
  };
}

describe("CanonicalSessionEngine", () => {
  it("retitles a Codex mirror without changing its events or activity timestamp", async () => {
    const store = new MemoryEngineStore();
    const engine = new CanonicalSessionEngine(store);
    const logicalSessionId = "logical-codex-retitle" as LogicalSessionId;
    const created = await engine.observeCodex({
      logicalSessionId,
      title: "完整首问污染标题",
      tags: [],
      archivedAt: null,
      workspaceId: "workspace-codex" as LogicalWorkspaceId,
      events: [event(logicalSessionId, "event-title-1", 0, "question")],
      sourceCursor: "cursor-title-1",
      observedAt: at,
    });

    const renamed = await engine.retitleCodexMirror({
      logicalSessionId,
      title: "精炼任务名",
      appliedAt: "2026-09-01T00:00:00.000Z",
    });

    expect(renamed).toMatchObject({ outcome: "advanced", logicalSessionId });
    expect(renamed?.versionId).not.toBe(created.versionId);
    expect(store.mutations.at(-1)?.version).toMatchObject({
      parentVersionIds: [created.versionId],
      events: [expect.objectContaining({ id: "event-title-1" })],
    });
    expect(store.sessions.get(logicalSessionId)?.session).toMatchObject({
      title: "精炼任务名",
      updatedAt: at,
    });
  });

  it("records a changed Codex cursor as a no-op without creating a version", async () => {
    const store = new MemoryEngineStore();
    const engine = new CanonicalSessionEngine(store);
    const logicalSessionId = "logical-codex-noop" as LogicalSessionId;
    const first = await engine.observeCodex({
      logicalSessionId,
      title: "Codex task",
      tags: ["codex"],
      archivedAt: null,
      workspaceId: "workspace-codex" as LogicalWorkspaceId,
      events: [event(logicalSessionId, "event-1", 0, "same")],
      sourceCursor: "cursor-1",
      observedAt: at,
    });
    const mutationCount = store.mutations.length;

    const repeated = await engine.observeCodex({
      logicalSessionId,
      title: "Codex task",
      tags: ["codex"],
      archivedAt: null,
      workspaceId: "workspace-codex" as LogicalWorkspaceId,
      events: [event(logicalSessionId, "event-1", 0, "same")],
      sourceCursor: "cursor-2",
      observedAt: "2026-08-31T00:01:00.000Z",
    });

    expect(first.outcome).toBe("created");
    expect(repeated).toMatchObject({ outcome: "noop", versionId: first.versionId });
    expect(store.mutations).toHaveLength(mutationCount);
    expect(store.observations.at(-1)).toMatchObject({ sourceCursor: "cursor-2" });
  });

  it("creates then advances one Codex mirror without changing its logical ID", async () => {
    const store = new MemoryEngineStore();
    const engine = new CanonicalSessionEngine(store);
    const logicalSessionId = "logical-codex-advance" as LogicalSessionId;
    const created = await engine.observeCodex({
      logicalSessionId,
      title: "Codex task",
      tags: [],
      archivedAt: null,
      workspaceId: null,
      events: [event(logicalSessionId, "event-1", 0, "question")],
      sourceCursor: "cursor-1",
      observedAt: at,
    });
    const advanced = await engine.observeCodex({
      logicalSessionId,
      title: "Codex task",
      tags: [],
      archivedAt: null,
      workspaceId: null,
      events: [
        event(logicalSessionId, "event-1", 0, "question"),
        event(logicalSessionId, "event-2", 1, "answer"),
      ],
      sourceCursor: "cursor-2",
      observedAt: "2026-08-31T00:02:00.000Z",
    });

    expect(created).toMatchObject({ outcome: "created", logicalSessionId });
    expect(advanced).toMatchObject({ outcome: "advanced", logicalSessionId });
    expect(advanced.versionId).not.toBe(created.versionId);
    expect(store.mutations.at(-1)?.version?.parentVersionIds).toEqual([created.versionId]);
  });

  it("commits DSH appends idempotently and exposes delayed derivation as one transaction", async () => {
    const store = new MemoryEngineStore();
    const engine = new CanonicalSessionEngine(store);
    const nativeId = "logical-dsh-native" as LogicalSessionId;
    await engine.appendDsh({
      logicalSessionId: nativeId,
      title: "DSH native",
      tags: ["dsh"],
      archivedAt: null,
      workspaceId: null,
      appendedEvents: [event(nativeId, "dsh-event-1", 0, "first", "dsh")],
      observedAt: at,
      projection: projection("operation-native-1"),
    });
    const appended = await engine.appendDsh({
      logicalSessionId: nativeId,
      title: "DSH native",
      tags: ["dsh"],
      archivedAt: null,
      workspaceId: null,
      appendedEvents: [event(nativeId, "dsh-event-2", 1, "second", "dsh")],
      observedAt: "2026-08-31T00:03:00.000Z",
      projection: { ...projection("operation-native-2"), nativeRevision: 2 },
    });
    const mutationCountBeforeReplay = store.mutations.length;
    const replayed = await engine.appendDsh({
      logicalSessionId: nativeId,
      title: "DSH native",
      tags: ["dsh"],
      archivedAt: null,
      workspaceId: null,
      appendedEvents: [event(nativeId, "dsh-event-2", 1, "second", "dsh")],
      observedAt: "2026-08-31T00:03:00.000Z",
      projection: { ...projection("operation-native-2"), nativeRevision: 2 },
    });
    expect(appended.outcome).toBe("advanced");
    expect(replayed).toEqual(appended);
    expect(store.mutations).toHaveLength(mutationCountBeforeReplay);

    const sourceId = "logical-codex-source" as LogicalSessionId;
    const source = await engine.observeCodex({
      logicalSessionId: sourceId,
      title: "Inherited title",
      tags: ["inherited"],
      archivedAt: null,
      workspaceId: "workspace-source" as LogicalWorkspaceId,
      events: [event(sourceId, "codex-source-1", 0, "source")],
      sourceCursor: "cursor-source",
      observedAt: at,
    });
    const childId = "logical-derived-child" as LogicalSessionId;
    const derived = await engine.appendDsh({
      logicalSessionId: sourceId,
      derivedLogicalSessionId: childId,
      baseVersionId: source.versionId,
      title: "Ignored DSH title",
      tags: ["ignored"],
      archivedAt: null,
      workspaceId: "workspace-ignored" as LogicalWorkspaceId,
      appendedEvents: [event(childId, "dsh-derived-1", 1, "continued", "dsh")],
      observedAt: "2026-08-31T00:04:00.000Z",
      projection: projection("operation-derived-1"),
    });
    expect(derived).toMatchObject({ outcome: "derived", logicalSessionId: childId });
    expect(store.mutations.at(-1)).toMatchObject({
      derivation: {
        childSessionId: childId,
        parentSessionId: sourceId,
        baseVersionId: source.versionId,
      },
      session: {
        authorityScope: "maintenance",
        originKind: "codex-derived",
        title: "Inherited title",
        tags: ["inherited"],
      },
      membership: { workspaceId: "workspace-source" },
    });
  });

  it("replans only portable DSH history through the Canonical conversation topology", async () => {
    const store = new MemoryEngineStore();
    const engine = new CanonicalSessionEngine(store);
    const logicalSessionId = "logical-portable-append" as LogicalSessionId;
    await engine.appendDsh({
      logicalSessionId,
      title: "Portable append",
      tags: [],
      archivedAt: null,
      workspaceId: null,
      canonicalHistoryMode: "portable",
      appendedEvents: [
        event(logicalSessionId, "portable-user", 0, "question", "dsh"),
        event(logicalSessionId, "portable-answer", 1, "answer", "dsh"),
      ],
      observedAt: at,
      projection: projection("operation-portable-1"),
    });

    const portableEvents = store.mutations.at(-1)?.version?.events ?? [];
    expect(portableEvents).toHaveLength(2);
    expect(portableEvents.every((item) => item.extensions["mcsf.conversationTopology.v1"] !== undefined)).toBe(true);

    const nativeId = "logical-native-no-plan" as LogicalSessionId;
    await engine.appendDsh({
      logicalSessionId: nativeId,
      title: "Native append",
      tags: [],
      archivedAt: null,
      workspaceId: null,
      canonicalHistoryMode: "native",
      appendedEvents: [event(nativeId, "native-user", 0, "question", "dsh")],
      observedAt: at,
      projection: projection("operation-native-no-plan"),
    });
    expect(store.mutations.at(-1)?.version?.events[0]?.extensions).toEqual({});
  });

  it("tombstones and restores without rewriting immutable versions", async () => {
    const store = new MemoryEngineStore();
    const engine = new CanonicalSessionEngine(store);
    const logicalSessionId = "logical-delete" as LogicalSessionId;
    await engine.appendDsh({
      logicalSessionId,
      title: "Delete fixture",
      tags: [],
      archivedAt: null,
      workspaceId: "workspace-delete" as LogicalWorkspaceId,
      appendedEvents: [event(logicalSessionId, "delete-event-1", 0, "keep", "dsh")],
      observedAt: at,
      projection: projection("operation-create-delete-fixture"),
    });
    const versionCount = store.versions.size;
    const deleted = await engine.tombstone({
      logicalSessionId,
      operationId: "operation-delete" as OperationId,
      checkpointId: "checkpoint-delete" as CheckpointId,
      deletedAt: "2026-08-31T01:00:00.000Z",
      retentionUntil: "2026-09-30T01:00:00.000Z",
    });
    const restored = await engine.restore({
      logicalSessionId,
      operationId: "operation-restore" as OperationId,
      restoredAt: "2026-08-31T02:00:00.000Z",
    });

    expect(deleted).toMatchObject({ outcome: "tombstoned", tombstoneState: "deleted" });
    expect(restored).toMatchObject({ outcome: "tombstoned", tombstoneState: "restored" });
    expect(store.versions.size).toBe(versionCount);
    expect(store.sessions.get(logicalSessionId)?.tombstone?.restoredAt).toBe(
      "2026-08-31T02:00:00.000Z",
    );

    const codexId = "logical-tombstoned-codex" as LogicalSessionId;
    await engine.observeCodex({
      logicalSessionId: codexId,
      title: "Hidden Codex mirror",
      tags: [],
      archivedAt: null,
      workspaceId: "workspace-codex-hidden" as LogicalWorkspaceId,
      events: [event(codexId, "hidden-codex-1", 0, "first")],
      sourceCursor: "cursor-hidden-1",
      observedAt: at,
    });
    await engine.tombstone({
      logicalSessionId: codexId,
      operationId: "operation-delete-codex" as OperationId,
      checkpointId: "checkpoint-delete-codex" as CheckpointId,
      deletedAt: "2026-08-31T03:00:00.000Z",
      retentionUntil: "2026-09-30T03:00:00.000Z",
    });
    await engine.observeCodex({
      logicalSessionId: codexId,
      title: "Hidden Codex mirror",
      tags: [],
      archivedAt: null,
      workspaceId: "workspace-codex-hidden" as LogicalWorkspaceId,
      events: [
        event(codexId, "hidden-codex-1", 0, "first"),
        event(codexId, "hidden-codex-2", 1, "updated"),
      ],
      sourceCursor: "cursor-hidden-2",
      observedAt: "2026-08-31T04:00:00.000Z",
    });
    expect(store.sessions.get(codexId)).toMatchObject({
      workspaceId: null,
      tombstone: { restoredAt: null },
    });
  });
});
