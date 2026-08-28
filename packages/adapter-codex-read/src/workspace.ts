import { workspaceIdFromPath, workspaceLabelFromPath } from "@linmu/dsh-session-domain";

export function codexWorkspaceId(cwd: string): string | null {
  return workspaceIdFromPath(cwd);
}

export function codexWorkspaceLabel(cwd: string): string | null {
  return workspaceLabelFromPath(cwd);
}
