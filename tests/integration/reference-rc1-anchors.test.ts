import { expect, it } from "vitest";
import type { CanonicalEventV1, LogicalSessionId, ProjectionRun } from "@linmu/dsh-session-contracts";
import { adapter, rc1NativeSessionId } from "../../packages/adapter-dsh-rc1/src/index.js";
import { JsonProjectionDirectory, projectionRootFor } from "../../packages/projection-lifecycle/src/index.js";
import { SqliteCanonicalRepository } from "../../packages/session-store/src/index.js";
import { createEngineFixture } from "../../apps/engine/test/helpers.js";

it("routes old RC1 anchors through the unchanged Engine reference endpoint and fails missing anchors", async () => {
  const fixture = await createEngineFixture("rc1-reference-identity");
  const at = "2026-09-05T00:00:00.000Z";
  const logicalSessionId = "logical-rc1-reference" as LogicalSessionId;
  const nativeSessionId = rc1NativeSessionId(logicalSessionId);
  const run: ProjectionRun = {
    schemaVersion: 1, id: "run-rc1-reference" as never, leaseId: "lease-rc1-reference" as never,
    branchId: "main" as never, instanceId: "rc1-fixture", profileId: "web", dshVersion: "0.1.2-rc.1",
    adapterId: adapter.manifest.id, state: "running", startedAt: at, heartbeatAt: at, checkpointId: null,
  };
  const session = { schemaVersion: 1 as const, id: logicalSessionId, authorityScope: "maintenance" as const,
    originKind: "maintenance-native" as const, headVersionId: null, title: "Private fixture text",
    tags: [], archivedAt: null, tombstonedAt: null, createdAt: at, updatedAt: at };
  const events = ["reasoning", "assistant-message"].map((kind, sequence): CanonicalEventV1 => ({
    schemaVersion: 1, id: `old-event-${sequence}`, logicalSessionId, sequence,
    kind: kind as CanonicalEventV1["kind"], role: "assistant", content: { text: "Private fixture text" },
    source: { platform: "codex", instanceId: "codex-fixture", sessionId: "task", eventId: `line-${sequence}`, cursor: String(sequence) },
    rawPayload: null, contentDigest: "sha256:fixture", extensions: { "mcsf.conversationTopology.v1": {
      schemaVersion: 1, turnId: "turn", turnOrdinal: 0, stepId: "step", stepOrdinal: 0,
      phase: kind === "reasoning" ? "reasoning" : "assistant", inference: "explicit",
    } },
  }));
  try {
    await new SqliteCanonicalRepository(fixture.engine.repository.database).createCanonicalSession(session);
    await fixture.engine.projectionRunRepository.createProjectionRun(run);
    await fixture.engine.projectionRunRepository.upsertProjectionSession({ schemaVersion: 1, runId: run.id,
      nativeSessionId, logicalSessionId, baseVersionId: null, mode: "maintenance-write", nativeRevision: 0,
      lastCommittedOperationId: null, derivedChildSessionId: null });
    const directory = new JsonProjectionDirectory(projectionRootFor(fixture.engine.projectionRuntimeRoot, run.id));
    await directory.initialize();
    await adapter.materialize({ run, workspaces: [], sessions: [{ session, events, workspaceId: null }] }, directory);
    const server = await fixture.startServer();
    const resolve = async (anchor: string) => {
      const response = await fetch(`${server.origin}/v1/references/resolve`, { method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ referenceType: "obsidian-reference", logicalSessionId,
          logicalAnchorId: anchor, legacyNativeSessionId: null, legacyNativeAnchorId: null }) });
      expect(response.status).toBe(200);
      return (await response.json()).resolution;
    };
    expect(await resolve("old-event-1")).toMatchObject({ status: "resolved", nativeSessionId,
      logicalAnchorId: "old-event-1", nativeAnchorId: "mcsf:turn:step:assistant" });
    expect(await resolve("missing-anchor")).toMatchObject({ status: "unavailable", nativeAnchorId: null });
    const logs = await fixture.engine.listStatusEvents({ runId: run.id, stage: "reference.roundtrip.verify" });
    expect(JSON.stringify(logs.items)).not.toContain("Private fixture text");
    expect(logs.items.at(-1)?.diagnosticDetailRef).toContain("unavailable");
    expect(logs.items.at(-1)?.state).toBe("failed");
  } finally {
    await fixture.cleanupAll();
  }
});
