import { describe, expect, it } from "vitest";

import {
  CONTRACT_SCHEMA_VERSION,
  jobEventSchema,
  normalizedSessionSchema,
  platformSessionKeySchema,
  scanRequestSchema,
  sessionVersionManifestSchema,
  syncPlanSchema,
} from "../src/index.js";

const provenance = {
  platform: "dsh" as const,
  instanceId: "dsh-fixture",
  sessionId: "session-1",
  observedAt: "2026-08-26T00:00:00.000Z",
};

describe("shared contracts", () => {
  it("rejects unknown platforms, excessive parents and path injection", () => {
    expect(
      platformSessionKeySchema.safeParse({
        platform: "eac",
        instanceId: "x",
        sessionId: "s",
      }).success,
    ).toBe(false);

    expect(
      sessionVersionManifestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        id: "sv_a",
        logicalSessionId: "ls_a",
        parents: ["sv_1", "sv_2", "sv_3"],
        bodyObject: "sha256:a",
        bodyHash: "a",
        metadataHash: "b",
        source: provenance,
        compatibility: { status: "compatible", issues: [] },
      }).success,
    ).toBe(false);

    expect(
      scanRequestSchema.safeParse({
        instanceIds: ["dsh-fixture"],
        root: "C:\\forbidden",
      }).success,
    ).toBe(false);
  });

  it("round-trips a complete normalized session and plan", () => {
    const session = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      key: {
        platform: "dsh" as const,
        instanceId: "dsh-fixture",
        sessionId: "session-1",
      },
      title: "fixture session",
      archived: false,
      workspaceId: "workspace-a",
      events: [
        {
          id: "ev_1",
          parentId: null,
          sequence: 0,
          kind: "message" as const,
          role: "user" as const,
          content: "hello",
          attachments: [
            { name: "example.txt", mediaType: "text/plain", source: "fixture:example" },
          ],
          source: {
            platform: "dsh" as const,
            instanceId: "dsh-fixture",
            sessionId: "session-1",
            eventId: "source-1",
            sequence: 0,
          },
          extensions: { imported: false, tags: ["fixture"] },
        },
      ],
      bodyHash: "body-a",
      metadataHash: "metadata-a",
      provenance,
      compatibility: { status: "compatible" as const, issues: [] },
    };

    const plan = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      id: "plan-a",
      hash: "hash-a",
      createdAt: "2026-08-26T00:01:00.000Z",
      logicalSessionId: "logical-a",
      baseVersionId: "version-base",
      source: {
        bindingId: "binding-source",
        key: session.key,
        versionId: "version-source",
        fingerprints: [{ ...session.key, kind: "content" as const, value: "source-hash" }],
      },
      target: {
        bindingId: "binding-target",
        key: { platform: "codex" as const, instanceId: "codex-fixture", sessionId: "thread-1" },
        versionId: "version-target",
        fingerprints: [],
      },
      adapterContracts: [
        {
          adapter: "fixture-dsh-read",
          platformVersion: "0.1.1-rc.2",
          schemaFingerprint: "fixture-schema",
        },
      ],
      operations: [
        { type: "append-events" as const, fromIndex: 1, eventIds: ["ev_2"] },
        { type: "update-title" as const, title: "new title" },
      ],
      risk: "safe" as const,
      confirmations: [],
      preconditions: [{ ...session.key, kind: "catalog" as const, value: "catalog-hash" }],
    };

    expect(normalizedSessionSchema.parse(session)).toEqual(session);
    expect(syncPlanSchema.parse(plan)).toEqual(plan);
    expect(normalizedSessionSchema.safeParse({ ...session, root: "D:\\live" }).success).toBe(false);
  });

  it("round-trips every job event variant", () => {
    const base = { jobId: "job-a", sequence: 1, at: "2026-08-26T00:02:00.000Z" };
    const events = [
      { ...base, type: "queued" as const },
      { ...base, type: "running" as const },
      { ...base, type: "progress" as const, current: 1, total: 2, message: "Scanning" },
      { ...base, type: "completed" as const, result: { platformWrites: 0 } },
      { ...base, type: "failed" as const, code: "ADAPTER_INCOMPATIBLE", message: "Unsupported" },
    ];

    for (const event of events) {
      expect(jobEventSchema.parse(event)).toEqual(event);
    }

    expect(jobEventSchema.safeParse({ ...events[0], cwd: "D:\\forbidden" }).success).toBe(false);
  });
});
