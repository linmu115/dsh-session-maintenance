import { describe, expect, it } from "vitest";
import type {
  LogicalSessionId,
  LogicalWorkspaceId,
  OperationId,
  SessionVersionId,
} from "@linmu/dsh-session-contracts";

import {
  CanonicalSessionEngine,
  derivedLogicalSessionIdFor,
  type CanonicalEngineMutation,
  type CanonicalEngineReceipt,
  type CanonicalSessionEngineStore,
  type CanonicalSessionSnapshot,
  type CanonicalVersionRecord,
  type CodexObservationRecord,
} from "../src/index.js";

const at = "2026-08-31T00:00:00.000Z";

class MemoryStore implements CanonicalSessionEngineStore {
  readonly sessions = new Map<string, CanonicalSessionSnapshot>();
  readonly versions = new Map<string, CanonicalVersionRecord>();
  readonly receipts = new Map<string, CanonicalEngineReceipt>();
  readonly mutations: CanonicalEngineMutation[] = [];
  failOperationOnce: OperationId | null = null;

  async getSession(id: LogicalSessionId) { return this.sessions.get(id); }
  async getVersion(id: SessionVersionId) { return this.versions.get(id); }
  async getOperationReceipt(id: OperationId) { return this.receipts.get(id); }
  async recordCodexObservation(_input: CodexObservationRecord) {}
  async commit(input: CanonicalEngineMutation) {
    if (this.failOperationOnce !== null && input.operationId === this.failOperationOnce) {
      this.failOperationOnce = null;
      throw new Error("synthetic transaction interruption");
    }
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

function event(logicalSessionId: LogicalSessionId, sequence: number, text: string, platform: "codex" | "dsh") {
  return {
    schemaVersion: 1 as const,
    id: `${platform}-event-${sequence}`,
    logicalSessionId,
    sequence,
    kind: sequence % 2 === 0 ? "user-message" as const : "assistant-message" as const,
    role: sequence % 2 === 0 ? "user" as const : "assistant" as const,
    content: { text },
    source: { platform, instanceId: `${platform}-fixture`, sessionId: `${platform}-session`, eventId: String(sequence), cursor: String(sequence) },
    contentDigest: `sha256:${platform}-${sequence}`,
    rawPayload: null,
    extensions: {},
  };
}

describe("Codex delayed derivation", () => {
  it("does not split on projection and creates exactly one deterministic child on the first DSH append", async () => {
    const store = new MemoryStore();
    const engine = new CanonicalSessionEngine(store);
    const sourceId = "logical-codex-delayed" as LogicalSessionId;
    const workspaceV1 = "workspace-codex-v1" as LogicalWorkspaceId;
    const base = await engine.observeCodex({
      logicalSessionId: sourceId,
      title: "Projected title",
      tags: ["projected"],
      archivedAt: null,
      workspaceId: workspaceV1,
      events: [event(sourceId, 0, "question", "codex")],
      sourceCursor: "cursor-1",
      observedAt: at,
    });

    // A read-only projection/close performs no Canonical Engine mutation.
    expect(store.sessions).toHaveLength(1);
    expect(store.mutations.filter((mutation) => mutation.kind === "dsh-derivation")).toHaveLength(0);

    const sourceAdvanced = await engine.observeCodex({
      logicalSessionId: sourceId,
      title: "Later Codex title",
      tags: ["later"],
      archivedAt: null,
      workspaceId: "workspace-codex-v2" as LogicalWorkspaceId,
      events: [
        event(sourceId, 0, "question", "codex"),
        event(sourceId, 1, "Codex continued independently", "codex"),
      ],
      sourceCursor: "cursor-2",
      observedAt: "2026-08-31T00:01:00.000Z",
    });
    const operationId = "operation-delayed-derivation" as OperationId;
    const appendInput = {
      logicalSessionId: sourceId,
      baseVersionId: base.versionId!,
      title: "Ignored runtime title",
      tags: ["ignored"],
      archivedAt: null,
      workspaceId: null,
      appendedEvents: [event(sourceId, 1, "DSH branch answer", "dsh")],
      observedAt: "2026-08-31T00:02:00.000Z",
      projection: {
        runId: "run-delayed" as never,
        leaseId: "lease-delayed" as never,
        branchId: "main" as never,
        adapterId: "adapter-alpha2" as never,
        nativeSessionId: "native-delayed" as never,
        operationId,
        nativeRevision: 2,
      },
    } as const;
    const historical = store.versions.get(base.versionId!)!;
    store.versions.set(historical.id, { ...historical, metadata: null, metadataAvailability: "unknown",
      metadataProvenance: "unavailable", contentDigest: null });
    await expect(engine.appendDsh(appendInput)).rejects.toThrow("Historical metadata is unavailable for derivation");
    expect(store.sessions).toHaveLength(1);
    expect(store.receipts.size).toBe(0);
    store.versions.set(historical.id, historical);
    store.failOperationOnce = operationId;
    await expect(engine.appendDsh(appendInput)).rejects.toThrow("synthetic transaction interruption");
    expect(store.sessions).toHaveLength(1);

    const derived = await engine.appendDsh(appendInput);
    const replayed = await engine.appendDsh(appendInput);
    const expectedChildId = derivedLogicalSessionIdFor(sourceId, operationId);
    expect(derived).toMatchObject({ outcome: "derived", logicalSessionId: expectedChildId });
    expect(replayed).toEqual(derived);
    expect(store.mutations.filter((mutation) => mutation.kind === "dsh-derivation")).toHaveLength(1);
    expect(store.sessions.get(sourceId)).toMatchObject({
      session: { authorityScope: "codex", headVersionId: sourceAdvanced.versionId },
      workspaceId: "workspace-codex-v2",
    });
    expect(store.sessions.get(expectedChildId)).toMatchObject({
      session: {
        authorityScope: "maintenance",
        originKind: "codex-derived",
        title: "Projected title",
        tags: ["projected"],
      },
      workspaceId: workspaceV1,
    });
    const childVersion = store.versions.get(derived.versionId!)!;
    expect(childVersion.parentVersionIds).toEqual([base.versionId]);
    expect(childVersion.events.map((item) => [item.sequence, item.logicalSessionId])).toEqual([
      [0, sourceId],
      [1, expectedChildId],
    ]);

    const continued = await engine.appendDsh({
      logicalSessionId: expectedChildId,
      baseVersionId: derived.versionId!,
      title: "Projected title",
      tags: ["projected"],
      archivedAt: null,
      workspaceId: workspaceV1,
      appendedEvents: [event(expectedChildId, 2, "DSH continued again", "dsh")],
      observedAt: "2026-08-31T00:03:00.000Z",
      projection: {
        ...appendInput.projection,
        operationId: "operation-derived-continuation" as OperationId,
        nativeRevision: 3,
      },
    });
    expect(continued).toMatchObject({ outcome: "advanced", logicalSessionId: expectedChildId });
    expect(store.versions.get(continued.versionId!)?.events.map((item) => [item.sequence, item.logicalSessionId])).toEqual([
      [0, sourceId],
      [1, expectedChildId],
      [2, expectedChildId],
    ]);
  });
});
