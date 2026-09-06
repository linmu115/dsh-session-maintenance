import { afterEach, describe, expect, it, vi } from "vitest";

import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { SqliteCanonicalRepository } from "../../../packages/session-store/src/index.js";
import { SqliteCanonicalSessionEngineStore } from "../../../packages/session-store/src/index.js";
import { CanonicalSessionEngine } from "../../../packages/canonical-session-engine/src/index.js";
import { sha256Canonical } from "../../../packages/session-domain/src/index.js";
import { SessionMaintenanceError } from "../../../packages/contracts/src/index.js";
import { ProjectionAppendError } from "../../../packages/projection-lifecycle/src/index.js";
import { normalizeRc1Append } from "../../../packages/adapter-dsh-rc1/src/normalize-append.js";
import { createEngineFixture } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));
const at = "2026-08-31T00:00:00.000Z";

describe("canonical dashboard API", () => {
  it("serves stable workspaces, events, and bidirectional lineage without a running DSH", async () => {
    const fixture = await createEngineFixture("canonical-dashboard");
    cleanups.push(fixture.cleanupAll);
    const canonical = new SqliteCanonicalRepository(fixture.engine.repository.database);
    await canonical.createCanonicalSession({
      schemaVersion: 1, id: "logical-parent" as never, authorityScope: "codex", originKind: "codex-mirror", headVersionId: null,
      title: "同名会话", tags: ["source"], archivedAt: null, tombstonedAt: null, createdAt: at, updatedAt: at,
    });
    fixture.engine.repository.database.prepare(
      `INSERT INTO session_versions (id, logical_session_id, body_object, body_hash, metadata_hash, manifest_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("version-parent", "logical-parent", "object-parent", "body-parent", "meta-parent", "{}", at);
    fixture.engine.repository.database.prepare(
      "UPDATE logical_sessions SET canonical_version_id = ?, head_version_id = ? WHERE id = ?",
    ).run("version-parent", "version-parent", "logical-parent");
    await canonical.createDerivedCanonicalSession({
      session: {
        schemaVersion: 1, id: "logical-child" as never, authorityScope: "maintenance", originKind: "codex-derived", headVersionId: null,
        title: "同名会话", tags: ["derived"], archivedAt: null, tombstonedAt: null, createdAt: at, updatedAt: at,
      },
      derivation: {
        schemaVersion: 1, childSessionId: "logical-child" as never, parentSessionId: "logical-parent" as never,
        baseVersionId: "version-parent" as never, kind: "dsh-continuation", triggerRunId: "run-1" as never,
        triggerOperationId: "operation-1" as never, createdAt: at,
      },
    });
    await canonical.upsertLogicalWorkspace({ schemaVersion: 1, id: "workspace-root" as never, parentId: null, name: "研究", sortKey: "a", deletedAt: null, createdAt: at, updatedAt: at });
    await canonical.upsertLogicalProject({ schemaVersion: 1, id: "project-skill" as never, name: "Skill 管理", sourcePlatform: "codex", sourceProjectId: "skill-project", sortKey: "a", deletedAt: null, createdAt: at, updatedAt: at });
    await canonical.replaceProjectRoots("project-skill" as never, [{ schemaVersion: 1, projectId: "project-skill" as never, path: "D:/AI/Skill", normalizedPath: "d:/ai/skill", ordinal: 0 }]);
    await canonical.setProjectMembership({ schemaVersion: 1, logicalSessionId: "logical-parent" as never, projectId: "project-skill" as never, revision: 1 });
    await canonical.setWorkspaceMembership({ schemaVersion: 1, logicalSessionId: "logical-parent" as never, workspaceId: "workspace-root" as never, displayOrder: 0, pinned: true, archived: false, revision: 1 });
    await canonical.setWorkspaceMembership({ schemaVersion: 1, logicalSessionId: "logical-child" as never, workspaceId: "workspace-root" as never, displayOrder: 1, pinned: false, archived: false, revision: 1 });
    await canonical.putCanonicalEvent({
      schemaVersion: 1, id: "event-parent", logicalSessionId: "logical-parent" as never, sequence: 0, kind: "user-message", role: "user",
      content: "静态正文", source: { platform: "codex", instanceId: "codex-fixture", sessionId: "native-parent", eventId: null, cursor: null },
      contentDigest: "sha256:event-parent", rawPayload: null, extensions: {},
    });
    const server = await fixture.startServer();
    const client = new MaintenanceClient({ origin: server.origin, token: server.token });
    const directory = await client.listCanonicalWorkspaces();
    expect(directory.workspaces[0]?.workspace.name).toBe("研究");
    expect(directory.workspaces[0]?.sessions.map((entry) => [entry.session.title, entry.session.originKind])).toEqual([
      ["同名会话", "codex-mirror"], ["同名会话", "codex-derived"],
    ]);
    const projects = await client.listCanonicalProjects();
    expect(projects.projects[0]?.project.name).toBe("Skill 管理");
    expect(projects.projects[0]?.sessions.map((entry) => entry.session.id)).toEqual(["logical-parent"]);
    expect(projects.unclassified.map((entry) => entry.session.id)).toEqual(["logical-child"]);
    const parent = await client.getCanonicalSession("logical-parent");
    expect(parent.project?.name).toBe("Skill 管理");
    expect(parent.workspace?.name).toBe("研究");
    expect(parent.events.map((event) => event.content)).toEqual(["静态正文"]);
    expect(parent.events.map((event) => event.readableText)).toEqual(["静态正文"]);
    expect(parent.nativeReferences).toEqual({ schemaVersion: 1, logicalSessionId: "logical-parent", references: [] });
    expect(parent.children[0]?.session.id).toBe("logical-child");
    expect(parent.headMetadata).toMatchObject({ metadataAvailability: "unknown", metadata: null });
    const child = await client.getCanonicalSession("logical-child");
    expect(child.parent?.session.id).toBe("logical-parent");
  });

  it("adds adapter-readable text to native DSH query results without changing stored evidence", async () => {
    const fixture = await createEngineFixture("synthetic-dashboard-readable-text");
    cleanups.push(fixture.cleanupAll);
    const database = fixture.engine.repository.database;
    const canonical = new SqliteCanonicalRepository(database);
    await canonical.createCanonicalSession({ schemaVersion: 1, id: "logical-native" as never,
      authorityScope: "maintenance", originKind: "maintenance-native", headVersionId: null, title: "Native fixture",
      tags: [], archivedAt: null, tombstonedAt: null, createdAt: at, updatedAt: at });
    const payload = { turn: 1, step: 1, message: { id: "assistant-1", role: "assistant",
      content: [{ type: "text", text: "hello from native DSH" }], source: { kind: "model", provider: "test", model: "test" } } };
    const normalized = await normalizeRc1Append({ runId: "synthetic-run", operationId: "synthetic-operation",
      nativeSessionId: "synthetic-native", nativeRevision: 1, observedAt: at,
      payload: { logicalSessionId: "logical-native", canonicalHistoryMode: "native", events: [
        { type: "assistant/message", seq: 0, time: Date.parse(at), data: payload, surfaceOp: "append" },
      ] },
    } as never);
    await canonical.putCanonicalEvent(normalized.events[0]!);
    const saved = database.prepare("SELECT event_json FROM canonical_events WHERE logical_session_id = ?").get("logical-native");
    const server = await fixture.startServer();
    const client = new MaintenanceClient({ origin: server.origin, token: server.token });
    const detail = await client.getCanonicalSession("logical-native");
    expect(detail.events[0]?.readableText).toBe("hello from native DSH");
    const { readableText: _text, ...original } = detail.events[0]!;
    expect(original).toEqual(normalized.events[0]);
    expect(database.prepare("SELECT event_json FROM canonical_events WHERE logical_session_id = ?").get("logical-native")).toEqual(saved);
  });
  it("versions metadata patches and rolls back the new head when a membership update fails", async () => {
    const fixture = await createEngineFixture("sm02-synthetic-metadata-api");
    cleanups.push(fixture.cleanupAll);
    const database = fixture.engine.repository.database;
    const store = new SqliteCanonicalSessionEngineStore(database, fixture.engine.repository.objectStore);
    const result = await new CanonicalSessionEngine(store).observeCodex({ logicalSessionId: "logical-metadata-api" as never,
      title: "Original", tags: [], archivedAt: null, workspaceId: null, events: [], sourceCursor: null, observedAt: at });
    const original = await store.getVersion(result.versionId!);
    const server = await fixture.startServer();
    const client = new MaintenanceClient({ origin: server.origin, token: server.token });
    const patched = await client.updateCanonicalSession(result.logicalSessionId, { title: "Edited", tags: ["kept"], archived: true });
    expect(patched.session.headVersionId).not.toBe(result.versionId);
    expect(patched.headMetadata).toMatchObject({ metadataAvailability: "available",
      metadata: { title: "Edited", tags: ["kept"], archivedAt: patched.session.archivedAt } });
    const newHead = (await store.getVersion(patched.session.headVersionId!))!;
    expect(newHead.metadataDigest).toBe(sha256Canonical(newHead.metadata));
    expect(await store.getVersion(result.versionId!)).toEqual(original);
    const versionCount = database.prepare("SELECT COUNT(*) AS count FROM session_versions").get();
    await expect(client.updateCanonicalSession(result.logicalSessionId, { title: "Must roll back", workspaceId: "missing-workspace" as never })).rejects.toThrow();
    expect((await client.getCanonicalSession(result.logicalSessionId)).session).toEqual(patched.session);
    expect(database.prepare("SELECT COUNT(*) AS count FROM session_versions").get()).toEqual(versionCount);
    const unauthenticated = await fetch(`${server.origin}/v1/canonical/sessions/${result.logicalSessionId}`);
    expect(unauthenticated.status).toBe(401);
  });

  it("maps typed metadata causes in projection wrappers and bounds cyclic cause chains", async () => {
    const fixture = await createEngineFixture("sm02-synthetic-metadata-error-api");
    cleanups.push(fixture.cleanupAll);
    const append = vi.spyOn(fixture.engine, "appendProjectionRuntimeEvent");
    const server = await fixture.startServer();
    const request = () => fetch(`${server.origin}/v1/runtime-broker/runs/run-sm02/append`, {
      method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, clientId: "client-sm02", operation: { runId: "run-sm02", operationId: "operation-sm02",
        nativeSessionId: "native-sm02", nativeRevision: 1, payload: {}, observedAt: at } }),
    });
    for (const code of ["HISTORICAL_METADATA_UNAVAILABLE", "OBJECT_CORRUPT"] as const) {
      append.mockRejectedValueOnce(new ProjectionAppendError("CANONICAL_COMMIT_FAILED", "Wrapped failure", {
        cause: new SessionMaintenanceError(code, "Synthetic historical metadata failure"),
      }));
      const response = await request();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
    const cyclic = new Error("HISTORICAL_METADATA_UNAVAILABLE is only message text");
    cyclic.cause = cyclic;
    append.mockRejectedValueOnce(cyclic);
    const response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });
});
