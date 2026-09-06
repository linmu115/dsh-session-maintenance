import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { SqliteRuntimeProjectResolver } from "../src/runtime-project-resolver.js";

describe("SqliteRuntimeProjectResolver", () => {
  it("maps exact normalized cwd to project membership without touching workspace membership", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE logical_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE logical_projects (id TEXT PRIMARY KEY, deleted_at TEXT);
      CREATE TABLE project_roots (
        project_id TEXT NOT NULL REFERENCES logical_projects(id),
        normalized_root_path TEXT NOT NULL
      );
      CREATE TABLE project_memberships (
        logical_session_id TEXT PRIMARY KEY REFERENCES logical_sessions(id),
        project_id TEXT REFERENCES logical_projects(id),
        revision INTEGER NOT NULL
      );
      CREATE TABLE workspace_memberships (
        logical_session_id TEXT PRIMARY KEY,
        workspace_id TEXT
      );
      CREATE TABLE session_derivations (
        child_session_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL
      );
      INSERT INTO logical_sessions VALUES ('logical-live');
      INSERT INTO logical_sessions VALUES ('logical-derived');
      INSERT INTO logical_projects VALUES ('project-deepseek', NULL);
      INSERT INTO project_roots VALUES ('project-deepseek', 'd:\\ai\\deepseek');
      INSERT INTO workspace_memberships VALUES ('logical-live', 'workspace-independent');
      INSERT INTO session_derivations VALUES ('logical-derived', 'logical-live');
    `);
    const resolver = new SqliteRuntimeProjectResolver(database);

    const projectId = await resolver.resolveProject("D:/AI/DeepSeek/");
    expect(projectId).toBe("project-deepseek");
    await resolver.assignProject("logical-live" as never, projectId!);

    await expect(resolver.resolveInheritedProject("logical-derived" as never)).resolves.toBe("project-deepseek");

    expect(database.prepare("SELECT project_id FROM project_memberships").get()).toEqual({ project_id: "project-deepseek" });
    expect(database.prepare("SELECT workspace_id FROM workspace_memberships").get()).toEqual({ workspace_id: "workspace-independent" });
    database.close();
  });

  it("fails closed on ambiguous roots and leaves unknown roots unassigned", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE project_roots (project_id TEXT NOT NULL, normalized_root_path TEXT NOT NULL);
      CREATE TABLE logical_projects (id TEXT PRIMARY KEY, deleted_at TEXT);
      INSERT INTO logical_projects VALUES ('project-a',NULL),('project-b',NULL);
      INSERT INTO project_roots VALUES ('project-a', 'd:\\shared'), ('project-b', 'd:\\shared');
    `);
    const resolver = new SqliteRuntimeProjectResolver(database);
    await expect(resolver.resolveProject("D:/shared")).rejects.toThrow("multiple canonical projects");
    await expect(resolver.resolveProject("D:/unknown")).resolves.toBeNull();
    database.close();
  });
});
