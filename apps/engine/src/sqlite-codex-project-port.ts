import type {
  LogicalProject,
  LogicalProjectId,
  ProjectMembership,
  ProjectRoot,
} from "@linmu/dsh-session-contracts";
import { sha256Canonical } from "@linmu/dsh-session-domain";
import { SqliteCanonicalRepository } from "@linmu/dsh-session-store";

import type {
  CodexCanonicalProjectAssignment,
  CodexCanonicalProjectPort,
} from "./codex-canonical-import.js";
import { normalizeCodexProjectPath } from "@linmu/dsh-adapter-codex-read";

function logicalProjectIdFor(input: CodexCanonicalProjectAssignment): LogicalProjectId {
  return `project-${sha256Canonical({
    platform: "codex",
    instanceId: input.instanceId,
    sourceProjectId: input.project.projectId,
  }).slice(0, 24)}` as LogicalProjectId;
}

/** Persists Codex project grouping without changing the session's independent workspace/cwd. */
export class SqliteCodexProjectPort implements CodexCanonicalProjectPort {
  constructor(private readonly repository: SqliteCanonicalRepository) {}

  async ensureWorkspace(input: CodexCanonicalProjectAssignment): Promise<void> {
    if (input.workspaceId === null) return;
    const existing = await this.repository.workspaces.get(input.workspaceId);
    await this.repository.upsertLogicalWorkspace({
      schemaVersion: 1,
      id: input.workspaceId,
      parentId: null,
      name: input.workspaceName,
      sortKey: input.workspacePath,
      deletedAt: null,
      createdAt: existing?.createdAt ?? input.observedAt,
      updatedAt: input.observedAt,
    });
  }

  async recordAssignment(input: CodexCanonicalProjectAssignment): Promise<void> {
    const projectId = logicalProjectIdFor(input);
    const existingProject = await this.repository.projects.getProject(projectId);
    const project: LogicalProject = {
      schemaVersion: 1,
      id: projectId,
      name: input.project.projectName,
      sourcePlatform: "codex",
      sourceProjectId: input.project.kind === "pending" || input.project.kind === "outside"
        ? null
        : input.project.projectId,
      sortKey: `${input.project.projectName}\0${projectId}`,
      deletedAt: null,
      createdAt: existingProject?.createdAt ?? input.observedAt,
      updatedAt: input.observedAt,
    };
    await this.repository.upsertLogicalProject(project);

    const roots: ProjectRoot[] = input.sourceProjectRoots.map((path, ordinal) => ({
      schemaVersion: 1,
      projectId,
      path,
      normalizedPath: normalizeCodexProjectPath(path),
      ordinal,
    }));
    await this.repository.replaceProjectRoots(projectId, roots);

    const existingMembership = await this.repository.projects.getMembership(input.logicalSessionId);
    if (existingMembership?.projectId === projectId) return;
    const membership: ProjectMembership = {
      schemaVersion: 1,
      logicalSessionId: input.logicalSessionId,
      projectId,
      revision: (existingMembership?.revision ?? -1) + 1,
    };
    await this.repository.setProjectMembership(membership);
  }
}
