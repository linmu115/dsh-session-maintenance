import type { RegisteredInstance } from "@linmu/dsh-session-contracts";

import type { CodexThreadRow } from "./parser.js";
import { withCodexReadSnapshot } from "./stable-read.js";

export const CODEX_PENDING_PROJECT_ID = "codex-project:pending";
export const CODEX_OUTSIDE_PROJECT_ID = "codex-project:outside";

export interface CodexProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly roots: readonly string[];
}

export interface CodexProjectCatalog {
  readonly projects: readonly CodexProjectRecord[];
}

export interface CodexProjectOverrides {
  readonly byThreadId?: Readonly<Record<string, string>>;
  readonly byWorkspacePath?: Readonly<Record<string, string>>;
}

export interface CodexProjectResolution {
  readonly projectId: string;
  readonly projectName: string;
  readonly kind: "thread-project-id" | "explicit-override" | "unique-longest-root" | "pending" | "outside";
  readonly candidates: readonly string[];
}

interface ProjectRow { readonly id: string; readonly name: string }
interface RootRow { readonly project_id: string; readonly path: string }

export function normalizeCodexProjectPath(path: string): string {
  return path
    .replace(/^\\\\\?\\/u, "")
    .replaceAll("/", "\\")
    .replace(/\\+$/u, "")
    .toLocaleLowerCase("en-US");
}

function pathContains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}\\`);
}

export function readCodexProjectCatalog(instance: RegisteredInstance): CodexProjectCatalog {
  return withCodexReadSnapshot(instance.root, (database) => {
    const tables = new Set((database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('projects', 'project_roots')",
    ).all() as unknown as Array<{ readonly name: string }>).map((row) => row.name));
    if (!tables.has("projects") || !tables.has("project_roots")) return { projects: [] };
    const projects = database.prepare("SELECT id, name FROM projects ORDER BY position, id").all() as unknown as ProjectRow[];
    const roots = database.prepare("SELECT project_id, path FROM project_roots ORDER BY project_id, position").all() as unknown as RootRow[];
    return {
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        roots: roots.filter((root) => root.project_id === project.id).map((root) => root.path),
      })),
    };
  });
}

export function resolveCodexProject(
  thread: CodexThreadRow,
  catalog: CodexProjectCatalog,
  overrides: CodexProjectOverrides = {},
): CodexProjectResolution {
  const byId = new Map(catalog.projects.map((project) => [project.id, project]));
  if (thread.project_id !== null && thread.project_id.length > 0) {
    return {
      projectId: thread.project_id,
      projectName: byId.get(thread.project_id)?.name ?? thread.project_id,
      kind: "thread-project-id",
      candidates: [thread.project_id],
    };
  }
  const workspace = normalizeCodexProjectPath(thread.cwd);
  const override = overrides.byThreadId?.[thread.id] ?? overrides.byWorkspacePath?.[workspace];
  if (override !== undefined) {
    return {
      projectId: override,
      projectName: byId.get(override)?.name ?? override,
      kind: "explicit-override",
      candidates: [override],
    };
  }
  const matches = catalog.projects.flatMap((project) => project.roots.map((root) => ({
    project,
    root: normalizeCodexProjectPath(root),
  }))).filter((item) => pathContains(item.root, workspace));
  const longest = Math.max(-1, ...matches.map((item) => item.root.length));
  const candidates = [...new Set(matches
    .filter((item) => item.root.length === longest)
    .map((item) => item.project.id))];
  if (candidates.length === 1) {
    const project = byId.get(candidates[0]!)!;
    return {
      projectId: project.id,
      projectName: project.name,
      kind: "unique-longest-root",
      candidates,
    };
  }
  if (candidates.length > 1) {
    return {
      projectId: CODEX_PENDING_PROJECT_ID,
      projectName: "待指定项目",
      kind: "pending",
      candidates,
    };
  }
  return {
    projectId: CODEX_OUTSIDE_PROJECT_ID,
    projectName: "Codex 项目外",
    kind: "outside",
    candidates: [],
  };
}
