import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import {
  SessionMaintenanceError,
  type ObservationHint,
  type PlatformSessionKey,
  type PlatformSessionSummary,
  type RegisteredInstance,
  type ScanCursor,
  type StableObservation,
  type UnstableRead,
} from "@linmu/dsh-session-contracts";

import {
  MAX_DSH_COMPRESSED_BYTES,
  decodeDshArtifact,
  decodeHeaderFrame,
  type DecodedDshArtifact,
  type DshSessionHeader,
} from "./zstd-codec.js";
import { dshWorkspaceId } from "./workspace.js";

const MAX_HEADER_READ_BYTES = 1024 * 1024;

export interface DshReadHooks {
  readonly fixtureGuard?: (root: string) => void;
  readonly afterRead?: (path: string) => void | Promise<void>;
  readonly onHeaderRead?: () => void;
  readonly onFullRead?: () => void;
}

interface ProjectionEntry {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceLabel: string | null;
  readonly workspacePath: string | null;
  readonly archived: boolean;
  readonly title: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredRecord(value: unknown, message: string): Record<string, unknown> {
  const parsed = record(value);
  if (parsed === undefined) throw new Error(message);
  return parsed;
}

export interface DshCatalogEntry {
  readonly key: PlatformSessionKey;
  readonly projectId: string;
  readonly workspaceLabel: string | null;
  readonly workspacePath: string | null;
  readonly artifactPath: string;
  readonly header: DshSessionHeader;
  readonly title: string;
  readonly archived: boolean;
  readonly size: number;
  readonly mtimeNs: string;
}

export interface DshObservationPayload extends DecodedDshArtifact {
  readonly format: "dsh-0.1.1-rc.2-session-v0";
  readonly projectId: string;
  readonly workspacePath: string | null;
  readonly title: string;
  readonly archived: boolean;
}

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function assertContained(root: string, path: string): Promise<string> {
  const resolvedRoot = await realpath(root);
  const resolvedPath = await realpath(path);
  if (!contained(resolvedRoot, resolvedPath)) {
    throw new SessionMaintenanceError(
      "LIVE_HOME_FORBIDDEN",
      `DSH path escapes registered root: ${path}`,
    );
  }
  return resolvedPath;
}

async function readHeader(path: string, hooks: DshReadHooks): Promise<DshSessionHeader> {
  const info = await stat(path);
  if (info.size > MAX_DSH_COMPRESSED_BYTES) {
    throw new Error(`DSH artifact exceeds ${MAX_DSH_COMPRESSED_BYTES} compressed bytes`);
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(info.size, MAX_HEADER_READ_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    hooks.onHeaderRead?.();
    try {
      return decodeHeaderFrame(buffer.subarray(0, bytesRead)).header;
    } catch (error) {
      if (info.size > MAX_HEADER_READ_BYTES) {
        throw new Error("DSH header frame exceeds the 1 MiB metadata-read limit", { cause: error });
      }
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function loadProjection(root: string): Promise<ReadonlyMap<string, ProjectionEntry>> {
  const projectionPath = await assertContained(root, join(root, "storages", "session_projcache.json"));
  const workspacePath = await assertContained(root, join(root, "storages", "workspace.json"));
  const projection = requiredRecord(JSON.parse(await readFile(projectionPath, "utf8")), "DSH projection storage is malformed");
  const projectionUnit = requiredRecord(projection.unit, "DSH projection unit is malformed");
  if (projectionUnit.name !== "session_projcache" || projectionUnit.version !== 3) {
    throw new Error("Unsupported DSH projection storage contract");
  }
  const projectionTables = requiredRecord(projection.tables, "DSH projection tables are malformed");
  const sessions = requiredRecord(projectionTables.sessions, "DSH projection sessions table is malformed");

  const workspace = requiredRecord(JSON.parse(await readFile(workspacePath, "utf8")), "DSH workspace storage is malformed");
  const workspaceUnit = requiredRecord(workspace.unit, "DSH workspace unit is malformed");
  if (workspaceUnit.name !== "workspace" || workspaceUnit.version !== 2) {
    throw new Error("Unsupported DSH workspace storage contract");
  }
  const workspaceGlobal = requiredRecord(workspace.global, "DSH workspace global state is malformed");
  if (!Array.isArray(workspaceGlobal.archivedSessionIds) || workspaceGlobal.archivedSessionIds.some((id) => typeof id !== "string")) {
    throw new Error("DSH archived session state is malformed");
  }
  const archived = new Set(workspaceGlobal.archivedSessionIds as string[]);
  const workspaceTables = requiredRecord(workspace.tables, "DSH workspace tables are malformed");
  const workspaces = requiredRecord(workspaceTables.workspaces, "DSH workspace table is malformed");
  const projectBySession = new Map<string, string>();
  const workspaceLabels = new Map<string, string>();
  const workspacePaths = new Map<string, string>();
  for (const [projectId, value] of Object.entries(workspaces)) {
    const item = requiredRecord(value, "DSH workspace entry is malformed");
    const title = item.title;
    const path = item.path;
    if (title !== undefined && typeof title !== "string") throw new Error("DSH workspace title is malformed");
    if (path !== undefined && typeof path !== "string") throw new Error("DSH workspace path is malformed");
    const label = typeof title === "string" && title.trim().length > 0
      ? title.trim()
      : typeof path === "string" && path.trim().length > 0
        ? basename(path.trim())
        : projectId;
    workspaceLabels.set(projectId, label);
    if (typeof path === "string" && path.trim().length > 0) workspacePaths.set(projectId, path.trim());
    if (!Array.isArray(item.sessionIds) || item.sessionIds.some((id) => typeof id !== "string")) {
      throw new Error("DSH workspace session IDs are malformed");
    }
    for (const sessionId of item.sessionIds as string[]) {
      if (projectBySession.has(sessionId)) {
        throw new SessionMaintenanceError("IDENTITY_CONFLICT", `DSH session belongs to multiple workspaces: ${sessionId}`);
      }
      projectBySession.set(sessionId, projectId);
    }
  }

  const result = new Map<string, ProjectionEntry>();
  const allSessionIds = new Set([...Object.keys(sessions), ...projectBySession.keys(), ...archived]);
  for (const id of allSessionIds) {
    const value = sessions[id];
    const entry = value === undefined ? undefined : requiredRecord(value, "DSH projection entry is malformed");
    const rows = entry === undefined ? undefined : requiredRecord(entry.rows, "DSH projection rows are malformed");
    const titleRow = rows?.title === undefined ? undefined : requiredRecord(rows.title, "DSH title projection is malformed");
    const title = titleRow?.val;
    if (title !== undefined && typeof title !== "string") throw new Error("DSH title projection value is malformed");
    result.set(id, {
      id,
      projectId: projectBySession.get(id) ?? "ungrouped",
      workspaceLabel: workspaceLabels.get(projectBySession.get(id) ?? "") ?? null,
      workspacePath: workspacePaths.get(projectBySession.get(id) ?? "") ?? null,
      archived: archived.has(id),
      title: title ?? id,
    });
  }
  return result;
}

export async function* iterateDshCatalog(
  instance: RegisteredInstance,
  cursor: ScanCursor | undefined,
  hooks: DshReadHooks,
): AsyncIterable<DshCatalogEntry> {
  hooks.fixtureGuard?.(instance.root);
  if (instance.platform !== "dsh" || instance.platformVersion !== "0.1.1-rc.2") {
    throw new SessionMaintenanceError(
      "ADAPTER_INCOMPATIBLE",
      `Unsupported DSH catalog contract: ${instance.platform}/${instance.platformVersion}`,
    );
  }
  const sessionsRoot = await assertContained(instance.root, join(instance.root, "sessions"));
  await assertContained(instance.root, join(instance.root, "storages"));
  const projection = await loadProjection(instance.root);
  const start = cursor === undefined ? 0 : Number.parseInt(cursor.opaque, 10);
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new TypeError(`Invalid DSH scan cursor: ${cursor?.opaque}`);
  }
  const seen = new Set<string>();
  let catalogIndex = 0;

  const projects = (await readdir(sessionsRoot, { withFileTypes: true })).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const project of projects) {
    const projectPath = join(sessionsRoot, project.name);
    if (project.isSymbolicLink()) {
      await assertContained(instance.root, projectPath);
      throw new SessionMaintenanceError("LIVE_HOME_FORBIDDEN", `Linked DSH project directory is forbidden: ${projectPath}`);
    }
    if (!project.isDirectory()) continue;
    await assertContained(instance.root, projectPath);

    const sessions = (await readdir(projectPath, { withFileTypes: true })).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const session of sessions) {
      const sessionPath = join(projectPath, session.name);
      if (session.isSymbolicLink()) {
        await assertContained(instance.root, sessionPath);
        throw new SessionMaintenanceError("LIVE_HOME_FORBIDDEN", `Linked DSH session directory is forbidden: ${sessionPath}`);
      }
      if (!session.isDirectory()) continue;
      await assertContained(instance.root, sessionPath);
      const artifactPath = await assertContained(instance.root, join(sessionPath, "session.jsonl.zstd"));
      const artifactInfo = await lstat(artifactPath);
      if (!artifactInfo.isFile() || artifactInfo.isSymbolicLink()) {
        throw new SessionMaintenanceError("LIVE_HOME_FORBIDDEN", `DSH artifact is not a regular file: ${artifactPath}`);
      }
      const header = await readHeader(artifactPath, hooks);
      if (seen.has(header.id)) {
        throw new SessionMaintenanceError("IDENTITY_CONFLICT", `Duplicate DSH header ID: ${header.id}`);
      }
      seen.add(header.id);
      if (header.id !== session.name) {
        throw new SessionMaintenanceError(
          "IDENTITY_CONFLICT",
          `DSH header ID does not match its directory: ${header.id}/${session.name}`,
        );
      }
      if (header.type !== "session" || header.version !== 0) {
        throw new SessionMaintenanceError(
          "ADAPTER_INCOMPATIBLE",
          `Unsupported DSH session header: ${header.type}/v${header.version}`,
        );
      }
      const info = await stat(artifactPath, { bigint: true });
      const metadata = projection.get(header.id);
      if (catalogIndex >= start) {
        yield {
          key: { platform: "dsh", instanceId: instance.id, sessionId: header.id },
          projectId: metadata?.projectId ?? project.name,
          workspaceLabel: metadata?.workspaceLabel ?? (project.name === "ungrouped" ? null : project.name),
          workspacePath: metadata?.workspacePath ?? null,
          artifactPath,
          header,
          title: metadata?.title ?? header.id,
          archived: metadata?.archived ?? false,
          size: Number(info.size),
          mtimeNs: info.mtimeNs.toString(),
        };
      }
      catalogIndex += 1;
    }
  }
}

export async function* listDshSessions(
  instance: RegisteredInstance,
  cursor: ScanCursor | undefined,
  hooks: DshReadHooks,
): AsyncIterable<PlatformSessionSummary> {
  for await (const entry of iterateDshCatalog(instance, cursor, hooks)) {
    yield {
      key: entry.key,
      title: entry.title,
      archived: entry.archived,
      workspaceId: dshWorkspaceId(instance.id, entry.projectId, entry.workspacePath),
      workspaceLabel: entry.workspaceLabel,
      updatedAt: new Date(
        entry.header.createdAt < 1_000_000_000_000
          ? entry.header.createdAt * 1000
          : entry.header.createdAt,
      ).toISOString(),
      hint: { size: entry.size, mtimeNs: entry.mtimeNs },
    };
  }
}

export async function observeDshSession(
  instance: RegisteredInstance,
  key: PlatformSessionKey,
  hint: ObservationHint | undefined,
  hooks: DshReadHooks,
): Promise<StableObservation | UnstableRead> {
  if (key.platform !== "dsh" || key.instanceId !== instance.id) {
    throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "DSH observation key mismatch");
  }
  let entry: DshCatalogEntry | undefined;
  for await (const candidate of iterateDshCatalog(instance, undefined, hooks)) {
    if (candidate.key.sessionId === key.sessionId) {
      entry = candidate;
      break;
    }
  }
  if (entry === undefined) {
    throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", `DSH session is absent: ${key.sessionId}`);
  }
  const before = await stat(entry.artifactPath, { bigint: true });
  if (
    (hint?.size !== undefined && BigInt(hint.size) !== before.size) ||
    (hint?.mtimeNs !== undefined && hint.mtimeNs !== before.mtimeNs.toString())
  ) {
    return { kind: "unstable", key, reason: "DSH artifact changed before read", retryable: true };
  }
  if (before.size > BigInt(MAX_DSH_COMPRESSED_BYTES)) {
    throw new Error(`DSH artifact exceeds ${MAX_DSH_COMPRESSED_BYTES} compressed bytes`);
  }
  hooks.onFullRead?.();
  const bytes = await readFile(entry.artifactPath);
  await hooks.afterRead?.(entry.artifactPath);
  const after = await stat(entry.artifactPath, { bigint: true });
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    return { kind: "unstable", key, reason: "DSH artifact changed during read", retryable: true };
  }
  const decoded = decodeDshArtifact(bytes);
  if (decoded.header.id !== key.sessionId || decoded.header.version !== 0) {
    throw new SessionMaintenanceError("IDENTITY_CONFLICT", `DSH decoded header changed identity: ${key.sessionId}`);
  }
  const payload: DshObservationPayload = {
    format: "dsh-0.1.1-rc.2-session-v0",
    ...decoded,
    projectId: entry.projectId,
    workspacePath: entry.workspacePath,
    title: entry.title,
    archived: entry.archived,
  };
  return {
    kind: "stable",
    key,
    fingerprint: {
      ...key,
      kind: "content",
      value: createHash("sha256").update(bytes).digest("hex"),
    },
    payload,
  };
}

export function isDshObservationPayload(value: unknown): value is DshObservationPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { readonly format?: unknown }).format === "dsh-0.1.1-rc.2-session-v0" &&
    Array.isArray((value as { readonly events?: unknown }).events)
  );
}
