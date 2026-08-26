import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

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
  readonly archived: boolean;
  readonly title: string;
}

export interface DshCatalogEntry {
  readonly key: PlatformSessionKey;
  readonly projectId: string;
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
  const path = await assertContained(root, join(root, "storages", "session_projcache.json"));
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as { readonly sessions?: unknown }).sessions)
  ) {
    throw new Error("DSH projection storage is malformed");
  }
  const result = new Map<string, ProjectionEntry>();
  for (const value of (parsed as { readonly sessions: unknown[] }).sessions) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as { readonly id?: unknown }).id !== "string" ||
      typeof (value as { readonly projectId?: unknown }).projectId !== "string" ||
      typeof (value as { readonly archived?: unknown }).archived !== "boolean" ||
      typeof (value as { readonly title?: unknown }).title !== "string"
    ) {
      throw new Error("DSH projection entry is malformed");
    }
    const entry = value as ProjectionEntry;
    if (result.has(entry.id)) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", `Duplicate DSH projection ID: ${entry.id}`);
    }
    result.set(entry.id, entry);
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
          projectId: project.name,
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
      workspaceId: entry.projectId,
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
