import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { openMaintenanceDatabase } from "../src/database.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("migration 009 logical projects", () => {
  it("adds project, root and membership tables without guessing a project from workspace data", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-migration-009-"));
    roots.push(root);
    const database = openMaintenanceDatabase(join(root, "metadata.sqlite"));
    databases.push(database);

    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 9 });
    expect(database.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name IN ('logical_projects', 'project_roots', 'project_memberships') ORDER BY name`,
    ).all()).toEqual([
      { name: "logical_projects" },
      { name: "project_memberships" },
      { name: "project_roots" },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM project_memberships").get()).toEqual({ count: 0 });
  });
});
