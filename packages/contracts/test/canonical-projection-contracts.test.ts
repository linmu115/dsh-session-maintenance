import { describe, expect, it } from "vitest";

import {
  adapterManifestV1Schema,
  canonicalEventV1Schema,
  logicalProjectSchema,
  projectMembershipSchema,
  projectRootSchema,
  canonicalSessionRecordSchema,
  logicalWorkspaceSchema,
  projectionOperationReceiptSchema,
  projectionRunSchema,
  projectionSessionSchema,
  sessionDerivationSchema,
  sessionTombstoneSchema,
  statusEventV1Schema,
  statusStageSchema,
} from "../src/index.js";

const at = "2026-08-31T00:00:00.000Z";

describe("canonical projection contracts", () => {
  it("round-trips the canonical session, workspace, derivation and tombstone records", () => {
    const session = {
      schemaVersion: 1 as const,
      id: "logical-codex-1",
      authorityScope: "codex" as const,
      originKind: "codex-mirror" as const,
      headVersionId: "version-codex-1",
      title: "Imported task",
      tags: ["research"],
      archivedAt: null,
      tombstonedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    const workspace = {
      schemaVersion: 1 as const,
      id: "workspace-research",
      parentId: null,
      name: "Research",
      sortKey: "0001",
      deletedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    const derivation = {
      schemaVersion: 1 as const,
      childSessionId: "logical-dsh-1",
      parentSessionId: session.id,
      baseVersionId: session.headVersionId,
      kind: "dsh-continuation" as const,
      triggerRunId: "run-alpha2-1",
      triggerOperationId: "operation-append-1",
      createdAt: at,
    };
    const tombstone = {
      schemaVersion: 1 as const,
      logicalSessionId: "logical-dsh-1",
      operationId: "operation-delete-1",
      checkpointId: "checkpoint-delete-1",
      previousWorkspaceId: workspace.id,
      deletedAt: at,
      retentionUntil: "2026-09-30T00:00:00.000Z",
      restoredAt: null,
    };

    expect(canonicalSessionRecordSchema.parse(session)).toEqual(session);
    expect(logicalWorkspaceSchema.parse(workspace)).toEqual(workspace);
    const project = {
      schemaVersion: 1 as const,
      id: "project-skill-management",
      name: "Skill 管理",
      sourcePlatform: "codex" as const,
      sourceProjectId: "codex-project-skill-management",
      sortKey: "0001",
      deletedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    const root = {
      schemaVersion: 1 as const,
      projectId: project.id,
      path: "D:/AI/Skill-Management",
      normalizedPath: "d:/ai/skill-management",
      ordinal: 0,
    };
    const membership = {
      schemaVersion: 1 as const,
      logicalSessionId: session.id,
      projectId: project.id,
      revision: 1,
    };
    expect(logicalProjectSchema.parse(project)).toEqual(project);
    expect(projectRootSchema.parse(root)).toEqual(root);
    expect(projectMembershipSchema.parse(membership)).toEqual(membership);
    expect(sessionDerivationSchema.parse(derivation)).toEqual(derivation);
    expect(sessionTombstoneSchema.parse(tombstone)).toEqual(tombstone);
  });

  it("round-trips an opaque canonical event without dropping its raw payload", () => {
    const event = {
      schemaVersion: 1 as const,
      id: "event-opaque-1",
      logicalSessionId: "logical-dsh-1",
      sequence: 2,
      kind: "opaque-unknown" as const,
      role: "unknown" as const,
      content: { display: "Unsupported native event" },
      source: {
        platform: "dsh" as const,
        instanceId: "alpha2-profile",
        sessionId: "native-session-1",
        eventId: "native-event-2",
        cursor: "2",
      },
      contentDigest: "sha256:event-opaque-1",
      rawPayload: { type: "future/event", payload: { kept: true } },
      extensions: { heldOut: true },
    };

    expect(canonicalEventV1Schema.parse(event)).toEqual(event);
  });

  it("round-trips projection, receipt, status and adapter manifest records", () => {
    const run = {
      schemaVersion: 1 as const,
      id: "run-alpha2-1",
      leaseId: "lease-alpha2-1",
      branchId: "main",
      instanceId: "launcher-alpha2",
      profileId: "profile-alpha2",
      dshVersion: "0.1.2-alpha.2",
      adapterId: "dsh-alpha2",
      state: "preparing" as const,
      startedAt: at,
      heartbeatAt: at,
      checkpointId: null,
    };
    const receipt = {
      schemaVersion: 1 as const,
      operationId: "operation-append-1",
      runId: run.id,
      logicalSessionId: "logical-dsh-1",
      nativeSessionId: "native-session-1",
      status: "committed" as const,
      canonicalVersionId: "version-dsh-2",
      projectionRevision: 2,
      committedAt: at,
    };
    const status = {
      schemaVersion: 1 as const,
      id: "status-1",
      at,
      runId: run.id,
      leaseId: run.leaseId,
      profileId: run.profileId,
      adapterId: run.adapterId,
      dshVersion: run.dshVersion,
      stage: "run.lease" as const,
      state: "started" as const,
      logicalSessionId: null,
      nativeSessionId: null,
      operationId: null,
      parentEventId: null,
      spanId: "span-run-lease-1",
      errorCode: null,
      durationMs: null,
      diagnosticDetailRef: null,
    };
    const manifest = {
      schemaVersion: 1 as const,
      id: "dsh-alpha2",
      displayName: "DSH Alpha2",
      adapterApiVersion: 1 as const,
      packageVersion: "1.0.0",
      testedDshVersions: ["0.1.2-alpha.2"],
      declaredDshRange: ">=0.1.2-alpha.2",
      capabilities: [
        "session-persistence",
        "unknown-event-round-trip",
        "deep-link-resolution",
      ] as const,
    };

    expect(projectionRunSchema.parse(run)).toEqual(run);
    expect(
      projectionSessionSchema.parse({
        schemaVersion: 1,
        runId: run.id,
        nativeSessionId: "native-draft-1",
        logicalSessionId: "logical-draft-1",
        baseVersionId: null,
        mode: "maintenance-write",
        nativeRevision: 0,
        lastCommittedOperationId: null,
        derivedChildSessionId: null,
      }),
    ).toMatchObject({ baseVersionId: null, nativeRevision: 0 });
    expect(projectionOperationReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(statusEventV1Schema.parse(status)).toEqual(status);
    expect(adapterManifestV1Schema.parse(manifest)).toEqual(manifest);
  });

  it("rejects unknown authority, status stages and adapter interface majors", () => {
    expect(
      canonicalSessionRecordSchema.safeParse({
        schemaVersion: 1,
        id: "logical-invalid",
        authorityScope: "dsh",
        originKind: "codex-mirror",
        headVersionId: null,
        title: "Invalid",
        tags: [],
        archivedAt: null,
        tombstonedAt: null,
        createdAt: at,
        updatedAt: at,
      }).success,
    ).toBe(false);

    expect(statusStageSchema.safeParse("projection.everything").success).toBe(false);

    expect(
      adapterManifestV1Schema.safeParse({
        schemaVersion: 1,
        id: "future-adapter",
        displayName: "Future adapter",
        adapterApiVersion: 2,
        packageVersion: "2.0.0",
        testedDshVersions: [],
        declaredDshRange: "*",
        capabilities: [],
      }).success,
    ).toBe(false);
  });
});
