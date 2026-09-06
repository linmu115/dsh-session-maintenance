import type { DatabaseSync } from "node:sqlite";
import { codexProjectMappingPolicySchema, type CodexProjectMappingPolicy } from "@linmu/dsh-session-contracts";

/** Pure storage boundary: no configuration or import-service dependencies. */
export function readOfflineCodexPolicy(database: DatabaseSync): CodexProjectMappingPolicy | null {
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_project_mapping_policy'").get() === undefined) return null;
  const row = database.prepare("SELECT policy_json FROM codex_project_mapping_policy WHERE id=1").get() as { policy_json: string } | undefined;
  return row === undefined ? null : codexProjectMappingPolicySchema.parse(JSON.parse(row.policy_json));
}

export function assertOfflineCodexPolicyEqual(left: CodexProjectMappingPolicy | null, right: CodexProjectMappingPolicy | null): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error("OFFLINE_CODEX_PROJECT_POLICY_CHANGED");
}
