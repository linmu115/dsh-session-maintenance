import { afterEach, describe, expect, it } from "vitest";

import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { SqliteCanonicalRepository } from "../../../packages/session-store/src/index.js";
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
    expect(parent.nativeReferences).toEqual({ schemaVersion: 1, logicalSessionId: "logical-parent", references: [] });
    expect(parent.children[0]?.session.id).toBe("logical-child");
    const child = await client.getCanonicalSession("logical-child");
    expect(child.parent?.session.id).toBe("logical-parent");
  });
});
