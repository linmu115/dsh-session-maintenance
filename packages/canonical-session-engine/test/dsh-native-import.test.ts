import { describe, expect, it, vi } from "vitest";
import type {
  AdapterId,
  LogicalSessionId,
  LogicalWorkspaceId,
  NativeSessionId,
  OperationId,
  SessionVersionId,
} from "@linmu/dsh-session-contracts";

import {
  DshNativeImportService,
  CanonicalSessionEngine,
  type CanonicalEngineMutation,
  type CanonicalEngineReceipt,
  type CanonicalSessionEngineStore,
  type CanonicalSessionSnapshot,
  type CanonicalVersionRecord,
  type CodexObservationRecord,
  type DshNativeImportSource,
} from "../src/index.js";

const logicalSessionId = "logical-native-import" as LogicalSessionId;
const nativeSessionId = "session-e7e36c2b-9f7f-4140-8685-e0499d50508e" as NativeSessionId;
const operationId = "operation-native-import" as OperationId;
const importedAt = "2026-09-01T00:00:00.000Z";

function source(status: "compatible" | "incompatible"): DshNativeImportSource {
  return {
    probe: async () => ({
      adapterId: "dsh-alpha2" as AdapterId,
      dshVersion: "0.1.2-alpha.2",
      status,
      issues: status === "compatible" ? [] : ["SESSION_FORMAT_UNSUPPORTED"],
      workspaceMembershipAuthority: "maintenance",
    }),
    read: async () => ({
      logicalSessionId,
      nativeSessionId,
      title: "Obsidian integration fixture",
      tags: ["dsh", "obsidian"],
      archivedAt: null,
      workspaceId: "workspace-deepseek" as LogicalWorkspaceId,
      events: [{
        schemaVersion: 1,
        id: "native-event-0",
        logicalSessionId,
        sequence: 0,
        kind: "user-message",
        role: "user",
        content: { text: "fixture" },
        source: {
          platform: "dsh",
          instanceId: "alpha2-fixture",
          sessionId: nativeSessionId,
          eventId: "0",
          cursor: "0",
        },
        contentDigest: "sha256:native-event-0",
        rawPayload: null,
        extensions: {},
      }],
    }),
  };
}

class MemoryStore implements CanonicalSessionEngineStore {
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
    if (input.operationId !== null) this.receipts.set(input.operationId, input.receipt);
    return input.receipt;
  }
}

describe("DshNativeImportService", () => {
  it("probes the Alpha2 capability before committing an initial maintenance-native session", async () => {
    const importDshNative = vi.fn(async () => ({
      outcome: "created" as const,
      operationId,
      logicalSessionId,
      versionId: "version-native" as never,
      tombstoneState: null,
      committedAt: importedAt,
    }));
    const service = new DshNativeImportService({
      engine: { importDshNative } as Pick<CanonicalSessionEngine, "importDshNative">,
      source: source("compatible"),
    });

    await expect(service.import({ operationId, nativeSessionId, importedAt })).resolves.toMatchObject({
      outcome: "created",
      logicalSessionId,
    });
    expect(importDshNative).toHaveBeenCalledWith(expect.objectContaining({
      operationId,
      nativeSessionId,
      workspaceId: "workspace-deepseek",
    }));
  });

  it("refuses an incompatible native format before reading or committing", async () => {
    const incompatible = source("incompatible");
    const read = vi.spyOn(incompatible, "read");
    const importDshNative = vi.fn();
    const service = new DshNativeImportService({
      engine: { importDshNative } as unknown as Pick<CanonicalSessionEngine, "importDshNative">,
      source: incompatible,
    });

    await expect(service.import({ operationId, nativeSessionId, importedAt }))
      .rejects.toThrow("SESSION_FORMAT_UNSUPPORTED");
    expect(read).not.toHaveBeenCalled();
    expect(importDshNative).not.toHaveBeenCalled();
  });

  it("refuses a reader that derives canonical workspace membership from native cwd", async () => {
    const unsafe = source("compatible");
    unsafe.probe = async () => ({
      adapterId: "dsh-alpha2" as AdapterId,
      dshVersion: "0.1.2-alpha.2",
      status: "compatible",
      issues: [],
      workspaceMembershipAuthority: "native-cwd",
    });
    const read = vi.spyOn(unsafe, "read");
    const importDshNative = vi.fn();
    const service = new DshNativeImportService({
      engine: { importDshNative } as unknown as Pick<CanonicalSessionEngine, "importDshNative">,
      source: unsafe,
    });

    await expect(service.import({ operationId, nativeSessionId, importedAt }))
      .rejects.toThrow("independently of SessionHeader.cwd");
    expect(read).not.toHaveBeenCalled();
    expect(importDshNative).not.toHaveBeenCalled();
  });

  it("commits an initial maintenance-native session without a fabricated projection receipt", async () => {
    const store = new MemoryStore();
    const engine = new CanonicalSessionEngine(store);
    const snapshot = await source("compatible").read(nativeSessionId);

    const created = await engine.importDshNative({ ...snapshot, operationId, importedAt });
    const replayed = await engine.importDshNative({ ...snapshot, operationId, importedAt });

    expect(created).toMatchObject({ outcome: "created", operationId, logicalSessionId });
    expect(replayed).toEqual(created);
    expect(store.mutations).toHaveLength(1);
    expect(store.mutations[0]).toMatchObject({
      kind: "dsh-native-import",
      session: { authorityScope: "maintenance", originKind: "maintenance-native" },
      membership: { workspaceId: "workspace-deepseek" },
      projectionReceipt: null,
    });
  });
});
