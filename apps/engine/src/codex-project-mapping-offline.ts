import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readCodexDesktopProjectDirectory } from "@linmu/dsh-adapter-codex-read";
import type { CodexProjectMappingPolicy } from "@linmu/dsh-session-contracts";
import type { CodexProjectScopeProvider } from "./codex-canonical-import.js";
import { activeDatabasePath, loadConfig } from "./config.js";
import { assertOfflineCodexPolicyEqual, readOfflineCodexPolicy } from "./codex-project-policy-storage.js";
export { assertOfflineCodexPolicyEqual, readOfflineCodexPolicy } from "./codex-project-policy-storage.js";

export async function readActiveOfflineCodexPolicy(stateRoot: string) {
  try { await readFile(join(stateRoot, "config.yaml"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const path = activeDatabasePath(stateRoot, await loadConfig(stateRoot));
  const database = new DatabaseSync(path, { readOnly: true });
  try { return { path, policy: readOfflineCodexPolicy(database) }; }
  finally { database.close(); }
}

/** Prevent callers from selecting a pre-policy source database beside the active one. */
export async function assertOfflineSourcePolicy(stateRoot: string, source: DatabaseSync): Promise<void> {
  const active = await readActiveOfflineCodexPolicy(stateRoot);
  if (active !== undefined) assertOfflineCodexPolicyEqual(readOfflineCodexPolicy(source), active.policy);
}

export function copyOfflineCodexPolicy(database: DatabaseSync, policy: CodexProjectMappingPolicy | null, at: string): void {
  if (policy === null) return;
  database.prepare("INSERT INTO codex_project_mapping_policy(id,policy_json,updated_at) VALUES(1,?,?)")
    .run(JSON.stringify(policy), at);
}

export function offlineCodexProjectScope(
  readPolicy: () => CodexProjectMappingPolicy | null | Promise<CodexProjectMappingPolicy | null>,
  fixtureGuard?: (root: string) => void,
): CodexProjectScopeProvider {
  return async (instance, signal) => {
    signal?.throwIfAborted();
    const policy = await readPolicy();
    if (policy === null || !policy.activeConfigured) return undefined;
    const directory = await readCodexDesktopProjectDirectory(instance, fixtureGuard === undefined ? {} : { fixtureGuard });
    signal?.throwIfAborted();
    if (!directory.safeForSelection) throw new Error("OFFLINE_CODEX_PROJECT_DIRECTORY_UNSAFE");
    const available = new Map(directory.projects.map(project => [`${encodeURIComponent(instance.id)}:${encodeURIComponent(project.projectId)}`, project.projectId]));
    const keys = policy.activeProjectKeys.filter(key => key.startsWith(`${encodeURIComponent(instance.id)}:`));
    if (keys.some(key => !available.has(key))) throw new Error("OFFLINE_CODEX_PROJECT_UNKNOWN");
    return { revision: policy.activeRevision, projectIds: keys.map(key => available.get(key)!), directory };
  };
}
