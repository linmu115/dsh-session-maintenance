import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { RegisteredInstance } from "@linmu/dsh-session-contracts";
import { assertFixtureSandbox, createFixtureSandbox } from "@linmu/dsh-session-test-support";
import { readCodexDesktopProjectDirectory } from "../src/project-directory.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
async function fixture() {
  const sandbox = await createFixtureSandbox("codex-project-directory");
  cleanups.push(sandbox.cleanup);
  const instance: RegisteredInstance = { id: "fixture", platform: "codex", displayName: "Fixture", root: sandbox.codexHome, platformVersion: "0.146.0" };
  const path = join(sandbox.codexHome, ".codex-global-state.json");
  const databasePath = join(sandbox.codexHome, "state_5.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, project_id TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,position INTEGER); CREATE TABLE project_roots(project_id TEXT,path TEXT,position INTEGER)");
  database.exec("INSERT INTO projects VALUES('server-a','Same name',0),('server-b','Same name',1),('server-empty','Empty',2); INSERT INTO project_roots VALUES('server-a','/shared',0),('server-b','/shared',0); INSERT INTO threads VALUES('thread-a',NULL),('thread-b',NULL),('outside',NULL)");
  database.close();
  const hostKey = `local:${sandbox.codexHome}`;
  const state: Record<string, unknown> = {
    "local-projects": {
      "desktop-a": { id: "desktop-a", name: "Same name", rootPaths: ["/shared"] },
      "g-p-cloud": { id: "g-p-cloud", name: "Same name", rootPaths: ["/shared"] },
    },
    "app-server-project-id-by-legacy-project-id-by-host": { [hostKey]: { "desktop-a": "server-a", "g-p-cloud": "server-b" } },
    "app-server-projects-migration-by-host": { [hostKey]: { version: 1, projectsMigrated: true, threadAssignmentsMigrated: false } },
    "thread-project-assignments": {
      "thread-a": { projectId: "desktop-a", projectKind: "local" },
      "thread-b": { projectId: "g-p-cloud", projectKind: "local" },
      "cloud-only": { projectId: "g-p-cloud", projectKind: "chatgpt" },
    },
  };
  const save = async () => writeFile(path, JSON.stringify(state));
  const sql = (text: string) => { const db = new DatabaseSync(databasePath); try { db.exec(text); } finally { db.close(); } };
  const read = () => readCodexDesktopProjectDirectory(instance, { fixtureGuard: assertFixtureSandbox });
  await save();
  return { instance, path, databasePath, state, hostKey, save, sql, read };
}

describe("explicit Codex desktop project membership", () => {
  it("reads all projects, preserves same-name IDs, includes local cloud-linked members, and never needs cwd or rollouts", async () => {
    const f = await fixture();
    const before = await Promise.all([readFile(f.path), readFile(f.databasePath)]);
    const result = await f.read();
    expect(result.safeForSelection).toBe(true);
    expect(result.projects.map(p => [p.projectId, p.memberThreadIds, p.kind])).toEqual([
      ["desktop-a", ["thread-a"], "local"], ["g-p-cloud", ["thread-b"], "mixed"], ["server-empty", [], "local"],
    ]);
    expect(result.assignments).toEqual({ "thread-a": { projectId: "desktop-a", basis: "desktop-explicit" }, "thread-b": { projectId: "g-p-cloud", basis: "desktop-explicit" } });
    expect(result.assignments).not.toHaveProperty("cloud-only");
    expect(result.assignments).not.toHaveProperty("outside");
    expect(await Promise.all([readFile(f.path), readFile(f.databasePath)])).toEqual(before);
    expect((await f.read()).fingerprint).toBe(result.fingerprint);
  });

  it("normalizes mapped server identities without double-registering projects", async () => {
    const f = await fixture();
    f.sql("UPDATE threads SET project_id='server-a' WHERE id='thread-a'");
    const result = await f.read();
    expect(result.safeForSelection).toBe(true);
    expect(result.projects).toHaveLength(3);
    expect(result.assignments["thread-a"]).toEqual({ projectId: "desktop-a", basis: "desktop-explicit" });
  });

  it("uses only database membership after migration, including an authoritative null", async () => {
    const f = await fixture();
    f.state["app-server-projects-migration-by-host"] = { [f.hostKey]: { version: 1, projectsMigrated: true, threadAssignmentsMigrated: true } };
    f.state["thread-project-assignments"] = { "thread-a": { projectId: "deleted-old-project", projectKind: "local" } };
    await f.save();
    f.sql("UPDATE threads SET project_id='server-b' WHERE id='thread-b'");
    const result = await f.read();
    expect(result.safeForSelection).toBe(true);
    expect(result.assignments).toEqual({ "thread-b": { projectId: "g-p-cloud", basis: "thread-project-id" } });
    expect(result.projects.find(p => p.projectId === "desktop-a")?.memberThreadIds).toEqual([]);
  });

  it("rejects membership conflict during migration rather than selecting either project", async () => {
    const f = await fixture();
    f.sql("UPDATE threads SET project_id='server-b' WHERE id='thread-a'");
    const result = await f.read();
    expect(result.safeForSelection).toBe(false);
    expect(result.issues.join(" ")).toContain("Conflicting explicit");
    expect(result.assignments).not.toHaveProperty("thread-a");
  });

  it.each(["unknown-desktop", "unknown-server", "ambiguous-mapping", "missing-assignments", "unsupported-migration", "invalid-project"])("marks %s metadata unsafe", async mode => {
    const f = await fixture();
    if (mode === "unknown-desktop") f.state["thread-project-assignments"] = { "thread-a": { projectId: "unknown", projectKind: "local" } };
    if (mode === "unknown-server") f.sql("UPDATE threads SET project_id='unknown' WHERE id='thread-a'");
    if (mode === "ambiguous-mapping") f.state["app-server-project-id-by-legacy-project-id-by-host"] = { [f.hostKey]: { "desktop-a": "server-a", "g-p-cloud": "server-a" } };
    if (mode === "missing-assignments") delete f.state["thread-project-assignments"];
    if (mode === "unsupported-migration") f.state["app-server-projects-migration-by-host"] = { [f.hostKey]: { version: 2, projectsMigrated: true, threadAssignmentsMigrated: true } };
    if (mode === "invalid-project") f.state["local-projects"] = { "desktop-a": { id: "different", name: "Broken", rootPaths: [] } };
    await f.save();
    const result = await f.read();
    expect(result.safeForSelection).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("does not interpret unreadable directory data as an empty safe selection", async () => {
    const f = await fixture();
    await writeFile(f.path, "{broken");
    expect((await f.read()).safeForSelection).toBe(false);
    await f.save();
    f.sql("DROP TABLE threads");
    expect((await f.read()).safeForSelection).toBe(false);
  });

  it("supports explicit legacy membership before database directory migration", async () => {
    const f = await fixture();
    delete f.state["app-server-projects-migration-by-host"];
    delete f.state["app-server-project-id-by-legacy-project-id-by-host"];
    f.sql("DROP TABLE project_roots; DROP TABLE projects");
    await f.save();
    const result = await f.read();
    expect(result.safeForSelection).toBe(true);
    expect(result.projects).toHaveLength(2);
    expect(result.assignments["thread-b"]?.projectId).toBe("g-p-cloud");
  });
});
