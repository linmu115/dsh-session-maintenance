import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { RegisteredInstance } from "@linmu/dsh-session-contracts";
import { withCodexReadSnapshot } from "./stable-read.js";

export interface CodexDesktopProject {
  /** Desktop identity, including legacy IDs retained by the desktop migration. */
  readonly projectId: string;
  readonly name: string;
  readonly serverProjectId: string | null;
  readonly roots: readonly string[];
  readonly source: "desktop" | "app-server";
  /** mixed means a ChatGPT-linked folder; members below are still local Codex only. */
  readonly kind: "local" | "mixed" | "unknown";
  readonly memberThreadIds: readonly string[];
}

export interface CodexDesktopProjectAssignment {
  readonly projectId: string;
  readonly basis: "desktop-explicit" | "thread-project-id";
}

export interface CodexDesktopProjectDirectory {
  readonly projects: readonly CodexDesktopProject[];
  readonly assignments: Readonly<Record<string, CodexDesktopProjectAssignment>>;
  readonly migration: { readonly projectsMigrated: boolean; readonly threadAssignmentsMigrated: boolean };
  readonly safeForSelection: boolean;
  readonly issues: readonly string[];
  readonly fingerprint: string;
}

type RecordValue = Record<string, unknown>;
function object(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function identity(path: string): string {
  const normalized = path.replace(/^\\\\\?\\/u, "").replaceAll("\\", "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function string(value: unknown): value is string { return typeof value === "string" && value.length > 0; }

/**
 * Reads directory and explicit membership metadata only, never rollout bodies or cwd.
 * Callers must reject unsafe snapshots before changing a selection or deleting imports.
 * This is independent of the older root-based migration resolver in projects.ts.
 */
export async function readCodexDesktopProjectDirectory(
  instance: RegisteredInstance,
  options: { readonly fixtureGuard?: (root: string) => void } = {},
): Promise<CodexDesktopProjectDirectory> {
  if (process.env.VITEST !== undefined && options.fixtureGuard === undefined) {
    throw new Error("Codex project directory requires a fixture guard under Vitest");
  }
  options.fixtureGuard?.(instance.root);
  if (instance.platform !== "codex") throw new TypeError("Codex project directory requires a Codex source");
  const root = await realpath(instance.root);
  options.fixtureGuard?.(root);
  const issues: string[] = [];
  const statePath = join(root, ".codex-global-state.json");
  let stateText: string | undefined;
  let state: RecordValue = {};
  try {
    const actual = await realpath(statePath);
    if (identity(actual) !== identity(statePath)) throw new Error("Project state path is redirected");
    stateText = await readFile(actual, "utf8");
    const parsed: unknown = JSON.parse(stateText);
    if (!object(parsed)) throw new Error("Invalid project state");
    state = parsed;
  } catch {
    issues.push("Desktop project state is missing, unreadable, or invalid.");
  }
  const field = (key: string, required = false): RecordValue => {
    const value = state[key];
    if (value === undefined && !required) return {};
    if (object(value)) return value;
    issues.push(`Invalid or missing project metadata: ${key}.`);
    return {};
  };
  const hostField = (key: string): RecordValue => {
    const entries = Object.entries(field(key)).filter(([host]) => host.startsWith("local:") && identity(host.slice(6)) === identity(root));
    if (entries.length > 1) issues.push(`Ambiguous local host metadata: ${key}.`);
    const value = entries[0]?.[1];
    if (value === undefined) return {};
    if (object(value)) return value;
    issues.push(`Invalid local host metadata: ${key}.`);
    return {};
  };
  const migrationValue = hostField("app-server-projects-migration-by-host");
  if (Object.keys(migrationValue).length > 0 && (migrationValue.version !== 1
    || typeof migrationValue.projectsMigrated !== "boolean" || typeof migrationValue.threadAssignmentsMigrated !== "boolean")) {
    issues.push("Unsupported or incomplete desktop project migration metadata.");
  }
  const migration = {
    projectsMigrated: migrationValue.projectsMigrated === true,
    threadAssignmentsMigrated: migrationValue.threadAssignmentsMigrated === true,
  };
  // Desktop 26.903 still edits THREAD_PROJECT_ASSIGNMENTS while the server's
  // directory is migrated. Its thread.project_id can therefore disagree with
  // the active desktop assignment. Only an explicit supported migration phase
  // establishes that authority; missing migration metadata remains conservative.
  const desktopAssignmentsAuthoritative = migrationValue.version === 1
    && migrationValue.projectsMigrated === true && migrationValue.threadAssignmentsMigrated === false;
  if (migration.threadAssignmentsMigrated && !migration.projectsMigrated) issues.push("Project assignment migration precedes directory migration.");
  const desktopProjects = field("local-projects", !migration.projectsMigrated);
  const desktopAssignments = field("thread-project-assignments", !migration.threadAssignmentsMigrated);
  const mappings = hostField("app-server-project-id-by-legacy-project-id-by-host");
  const serverToDesktop = new Map<string, string>();
  const desktopToServer = new Map<string, string>();
  for (const [desktopId, serverId] of Object.entries(mappings)) {
    if (!string(desktopId) || !string(serverId)) { issues.push("Invalid desktop/server project identity mapping."); continue; }
    if (serverToDesktop.has(serverId) && serverToDesktop.get(serverId) !== desktopId) {
      issues.push(`Ambiguous server project identity: ${serverId}.`);
      continue;
    }
    serverToDesktop.set(serverId, desktopId);
    desktopToServer.set(desktopId, serverId);
  }

  type ServerProject = { id: string; name: string };
  type ServerRoot = { project_id: string; path: string };
  type Thread = { id: string; project_id: string | null };
  let database: { projects: ServerProject[]; roots: ServerRoot[]; threads: Thread[] } = { projects: [], roots: [], threads: [] };
  try {
    database = withCodexReadSnapshot(root, db => {
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
      if (!tables.has("threads")) throw new Error("Missing thread catalog");
      const columns = new Set((db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map(row => row.name));
      if (!columns.has("project_id") && migration.threadAssignmentsMigrated) throw new Error("Missing authoritative project membership column");
      if (migration.projectsMigrated && (!tables.has("projects") || !tables.has("project_roots"))) throw new Error("Missing migrated project directory");
      return {
        projects: tables.has("projects") ? db.prepare("SELECT id, name FROM projects ORDER BY position,id").all() as ServerProject[] : [],
        roots: tables.has("project_roots") ? db.prepare("SELECT project_id,path FROM project_roots ORDER BY project_id,position").all() as ServerRoot[] : [],
        threads: db.prepare(`SELECT id,${columns.has("project_id") ? "project_id" : "NULL AS project_id"} FROM threads ORDER BY id`).all() as Thread[],
      };
    });
  } catch { issues.push("Local Codex project or thread metadata could not be read consistently."); }
  // Desktop writes replace the JSON file atomically; reject cross-file snapshots if it changed.
  if (stateText !== undefined && await readFile(statePath, "utf8").catch(() => undefined) !== stateText) {
    issues.push("Desktop project metadata changed while reading the directory; retry.");
  }

  const projects = new Map<string, CodexDesktopProject>();
  for (const [id, value] of Object.entries(desktopProjects)) {
    if (!string(id) || !object(value) || value.id !== id || !string(value.name)
      || !Array.isArray(value.rootPaths) || !value.rootPaths.every(string)) {
      issues.push(`Invalid desktop project record: ${id}.`);
      continue;
    }
    projects.set(id, { projectId: id, name: value.name, roots: value.rootPaths,
      serverProjectId: desktopToServer.get(id) ?? null, source: "desktop",
      kind: id.startsWith("g-p-") ? "mixed" : "local", memberThreadIds: [] });
  }
  const knownServerIds = new Set(database.projects.map(project => project.id));
  for (const [desktopId, serverId] of desktopToServer) {
    if (migration.projectsMigrated && !knownServerIds.has(serverId)) issues.push(`Mapped server project is unavailable: ${desktopId}.`);
  }
  for (const project of database.projects) {
    if (!string(project.id) || !string(project.name)) { issues.push("Invalid server project record."); continue; }
    const id = serverToDesktop.get(project.id) ?? project.id;
    const existing = projects.get(id);
    if (projects.has(project.id) && project.id !== id) issues.push(`Project identity collides with a desktop project: ${project.id}.`);
    projects.set(id, { projectId: id, name: project.name, serverProjectId: project.id,
      roots: database.roots.filter(row => row.project_id === project.id).map(row => row.path),
      source: existing?.source ?? "app-server", kind: existing?.kind ?? (id.startsWith("g-p-") ? "mixed" : "local"), memberThreadIds: [] });
  }
  for (const rootRow of database.roots) {
    if (!knownServerIds.has(rootRow.project_id) || !string(rootRow.path)) issues.push("Invalid or orphaned server project root.");
  }
  const canonicalId = (id: string): string => serverToDesktop.get(id) ?? id;
  const assignments: Record<string, CodexDesktopProjectAssignment> = Object.create(null) as Record<string, CodexDesktopProjectAssignment>;
  for (const thread of database.threads) {
    const explicit = migration.threadAssignmentsMigrated ? undefined : desktopAssignments[thread.id];
    let desktopId: string | undefined;
    if (explicit !== undefined) {
      if (!object(explicit) || !string(explicit.projectId) || !["local", "remote", "chatgpt"].includes(String(explicit.projectKind))) {
        issues.push(`Invalid explicit project assignment: ${thread.id}.`);
      } else if (explicit.projectKind !== "local") {
        issues.push(`Local thread has a non-local project assignment: ${thread.id}.`);
      } else desktopId = canonicalId(explicit.projectId);
    }
    let serverId: string | undefined;
    if (thread.project_id !== null) {
      if (!string(thread.project_id) || !knownServerIds.has(thread.project_id)) issues.push(`Unknown thread project identity: ${thread.id}.`);
      else serverId = canonicalId(thread.project_id);
    }
    if (desktopId !== undefined && !projects.has(desktopId)) issues.push(`Unknown explicit project identity: ${thread.id}.`);
    if (!migration.threadAssignmentsMigrated && !desktopAssignmentsAuthoritative
      && desktopId !== undefined && serverId !== undefined && desktopId !== serverId) {
      issues.push(`Conflicting explicit project membership: ${thread.id}.`);
      continue;
    }
    const projectId = migration.threadAssignmentsMigrated ? serverId : desktopId ?? serverId;
    if (projectId === undefined || !projects.has(projectId)) continue;
    assignments[thread.id] = { projectId, basis: !migration.threadAssignmentsMigrated && desktopId !== undefined ? "desktop-explicit" : "thread-project-id" };
  }
  const resultProjects = [...projects.values()].map(project => ({ ...project,
    memberThreadIds: Object.entries(assignments).filter(([, assignment]) => assignment.projectId === project.projectId).map(([id]) => id),
  }));
  const uniqueIssues = [...new Set(issues)];
  const result = { projects: resultProjects, assignments, migration, safeForSelection: uniqueIssues.length === 0, issues: uniqueIssues };
  return { ...result, fingerprint: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
}
