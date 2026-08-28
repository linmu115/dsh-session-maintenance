import { sha256Canonical, workspaceIdFromPath } from "@linmu/dsh-session-domain";

export function dshWorkspaceId(instanceId: string, projectId: string, workspacePath?: string | null): string | null {
  if (projectId === "ungrouped") return null;
  const pathIdentity = workspacePath === undefined || workspacePath === null ? null : workspaceIdFromPath(workspacePath);
  if (pathIdentity !== null) return pathIdentity;
  return `workspace_${sha256Canonical({ instanceId, projectId }).slice(0, 24)}`;
}
