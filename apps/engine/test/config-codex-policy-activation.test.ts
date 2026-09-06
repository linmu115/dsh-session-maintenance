import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexProjectMappingPolicy } from "@linmu/dsh-session-contracts";
import { createFixtureSandbox } from "../../../packages/test-support/src/index.js";
import { activateDatabaseFile, configPathFor, initializeStateRoot, loadConfig } from "../src/config.js";
import { readOfflineCodexPolicy } from "../src/codex-project-mapping-offline.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const configuredPolicy: CodexProjectMappingPolicy = {
  revision: 8, activeRevision: 7, configured: true, activeConfigured: true,
  projectKeys: ["codex:new-project"], activeProjectKeys: ["codex:active-project"], includeFutureSessions: true,
};

async function fixture() {
  const sandbox = await createFixtureSandbox("config-codex-policy-activation"); cleanups.push(sandbox.cleanup);
  const stateRoot = join(sandbox.root, "state"); await mkdir(stateRoot); await initializeStateRoot(stateRoot);
  const currentPath = join(stateRoot, "metadata.sqlite");
  const candidateFile = "metadata.candidate.sqlite";
  const candidatePath = join(stateRoot, candidateFile);
  const create = (path: string, policy: CodexProjectMappingPolicy | "legacy" | "empty" | "corrupt" | "invalid") => {
    const database = new DatabaseSync(path);
    try {
      database.exec("CREATE TABLE fixture_content (id TEXT PRIMARY KEY); INSERT INTO fixture_content VALUES ('synthetic')");
      if (policy === "legacy") return;
      database.exec("CREATE TABLE codex_project_mapping_policy(id INTEGER PRIMARY KEY, policy_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
      if (policy === "empty") return;
      database.prepare("INSERT INTO codex_project_mapping_policy VALUES(1,?,?)").run(
        policy === "corrupt" ? "{broken" : policy === "invalid" ? "{}" : JSON.stringify(policy), "2026-09-06T00:00:00.000Z",
      );
    } finally { database.close(); }
  };
  return { stateRoot, currentPath, candidateFile, candidatePath, create };
}

describe("database pointer activation preserves configured Codex project policy", () => {
  it.each(["active", "pending-first-activation"])("allows an identical complete %s policy without changing either database", async mode => {
    const f = await fixture();
    const policy = mode === "active" ? configuredPolicy : { ...configuredPolicy, activeConfigured: false, activeRevision: 0, activeProjectKeys: [] };
    f.create(f.currentPath, policy);
    // Stored JSON field order is irrelevant; both readers validate through the policy schema.
    f.create(f.candidatePath, Object.fromEntries(Object.entries(policy).reverse()) as CodexProjectMappingPolicy);
    const before = await Promise.all([readFile(f.currentPath), readFile(f.candidatePath)]);
    const config = await activateDatabaseFile(f.stateRoot, f.candidateFile);
    expect(config.databaseFile).toBe(f.candidateFile);
    expect((await loadConfig(f.stateRoot)).databaseFile).toBe(f.candidateFile);
    expect(await Promise.all([readFile(f.currentPath), readFile(f.candidatePath)])).toEqual(before);
    const candidate = new DatabaseSync(f.candidatePath, { readOnly: true });
    try { expect(readOfflineCodexPolicy(candidate)).toEqual(policy); } finally { candidate.close(); }
  });

  it.each([
    "missing-file", "legacy-schema", "missing-row", "older-revision", "saved-selection-changed",
    "active-selection-changed", "unconfigured-candidate", "corrupt-json", "invalid-policy",
  ])("rejects %s and leaves the active pointer and policy untouched", async mode => {
    const f = await fixture(); f.create(f.currentPath, configuredPolicy);
    if (mode === "legacy-schema") f.create(f.candidatePath, "legacy");
    else if (mode === "missing-row") f.create(f.candidatePath, "empty");
    else if (mode === "older-revision") f.create(f.candidatePath, { ...configuredPolicy, revision: 6, activeRevision: 5 });
    else if (mode === "saved-selection-changed") f.create(f.candidatePath, { ...configuredPolicy, projectKeys: [] });
    else if (mode === "active-selection-changed") f.create(f.candidatePath, { ...configuredPolicy, activeProjectKeys: [] });
    else if (mode === "unconfigured-candidate") f.create(f.candidatePath, { ...configuredPolicy, configured: false, activeConfigured: false });
    else if (mode === "corrupt-json") f.create(f.candidatePath, "corrupt");
    else if (mode === "invalid-policy") f.create(f.candidatePath, "invalid");
    const configBefore = await readFile(configPathFor(f.stateRoot), "utf8");
    const sourceBefore = await readFile(f.currentPath);
    await expect(activateDatabaseFile(f.stateRoot, f.candidateFile)).rejects.toThrow("DATABASE_ACTIVATION_CODEX_POLICY_REJECTED");
    expect(await readFile(configPathFor(f.stateRoot), "utf8")).toBe(configBefore);
    expect((await loadConfig(f.stateRoot)).databaseFile).toBe("metadata.sqlite");
    expect(await readFile(f.currentPath)).toEqual(sourceBefore);
    if (mode === "missing-file") await expect(stat(f.candidatePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unreadable active policy instead of treating it as unconfigured", async () => {
    const f = await fixture(); f.create(f.currentPath, "corrupt"); f.create(f.candidatePath, "legacy");
    const before = await readFile(configPathFor(f.stateRoot), "utf8");
    await expect(activateDatabaseFile(f.stateRoot, f.candidateFile)).rejects.toThrow("DATABASE_ACTIVATION_CODEX_POLICY_UNREADABLE");
    expect(await readFile(configPathFor(f.stateRoot), "utf8")).toBe(before);
  });

  it.each(["missing-database", "legacy-schema", "explicit-unconfigured"])("preserves historical pointer behavior for %s", async mode => {
    const f = await fixture();
    if (mode === "legacy-schema") f.create(f.currentPath, "legacy");
    else if (mode === "explicit-unconfigured") f.create(f.currentPath, {
      revision: 0, activeRevision: 0, configured: false, activeConfigured: false, projectKeys: [], activeProjectKeys: [], includeFutureSessions: true,
    });
    // Unconfigured state historically permits pointing at a not-yet-created database.
    await expect(activateDatabaseFile(f.stateRoot, f.candidateFile)).resolves.toMatchObject({ databaseFile: f.candidateFile });
    expect((await loadConfig(f.stateRoot)).databaseFile).toBe(f.candidateFile);
  });
});
