import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { normalizeCodexProjectPath } from "@linmu/dsh-adapter-codex-read";
import {
  decodeDshArtifact,
  dshEventSequence,
  dshEventTime,
  type DshSessionEvent,
} from "@linmu/dsh-adapter-dsh";
import { normalizeAlpha2Append } from "@linmu/dsh-session-adapter-alpha2";
import { CanonicalSessionEngine } from "@linmu/dsh-canonical-session-engine";
import type {
  CanonicalEventV1,
  AdapterEvidencePort,
  JsonValue,
  LogicalProjectId,
  LogicalSessionId,
  LogicalWorkspaceId,
  NativeSessionId,
  OperationId,
  RegisteredInstance,
  RunId,
} from "@linmu/dsh-session-contracts";
import { logicalSessionIdFor, sha256Canonical } from "@linmu/dsh-session-domain";
import {
  openMaintenanceDatabase,
  SqliteCanonicalRepository,
  SqliteCanonicalSessionEngineStore,
  SqliteAdapterEvidenceStore,
  ZstdContentObjectStore,
} from "@linmu/dsh-session-store";

import { CodexCanonicalImportService, type CodexCanonicalImportResult } from "./codex-canonical-import.js";
import { SqliteCodexProjectPort } from "./sqlite-codex-project-port.js";

const SESSION_ARTIFACT = "session.jsonl.zstd";

export type CanonicalReseedStage =
  | "reseed.candidate.open"
  | "reseed.dsh.read"
  | "reseed.dsh.import"
  | "reseed.codex.import"
  | "reseed.codex.session"
  | "reseed.verify";

export interface CanonicalReseedStatus {
  readonly stage: CanonicalReseedStage;
  readonly state: "started" | "succeeded";
  readonly detail: string;
}

export interface CanonicalReseedManifest {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly candidatePath: string;
  readonly candidateDigest: string;
  readonly retainedDshSessionIds: readonly string[];
  readonly dshImported: number;
  readonly codex: CodexCanonicalImportResult;
  readonly counts: {
    readonly logicalSessions: number;
    readonly canonicalEvents: number;
    readonly logicalProjects: number;
    readonly projectMemberships: number;
    readonly logicalWorkspaces: number;
    readonly workspaceMemberships: number;
    readonly tombstones: number;
  };
  readonly integrityCheck: "ok";
  readonly foreignKeyViolations: 0;
}

export interface CanonicalReseedInput {
  readonly stateRoot: string;
  readonly candidateFile: string;
  readonly dshHome: string;
  readonly dshInstanceId: string;
  readonly retainedDshSessionIds: readonly string[];
  readonly maintenanceProjectName: string;
  readonly maintenanceProjectRoot: string;
  readonly codexInstance: RegisteredInstance;
  readonly expectedCodexSessions?: number;
  readonly fixtureGuard?: (root: string) => void;
  readonly now?: () => string;
  readonly onStatus?: (status: CanonicalReseedStatus) => void | Promise<void>;
}

interface LocatedDshSession {
  readonly nativeSessionId: string;
  readonly artifactPath: string;
}

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function checkedDirectory(path: string): Promise<string> {
  const sourceInfo = await lstat(path);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error(`Expected a physical directory: ${path}`);
  const actual = await realpath(path);
  const info = await lstat(actual);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a physical directory: ${path}`);
  return actual;
}

async function locateDshSessions(
  dshHome: string,
  retainedSessionIds: ReadonlySet<string>,
): Promise<readonly LocatedDshSession[]> {
  const root = await checkedDirectory(dshHome);
  const sessionsRoot = await checkedDirectory(join(root, "sessions"));
  if (!contained(root, sessionsRoot)) throw new Error("DSH sessions root escapes the selected home");
  const located = new Map<string, LocatedDshSession>();
  for (const project of await readdir(sessionsRoot, { withFileTypes: true })) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const projectPath = await checkedDirectory(join(sessionsRoot, project.name));
    if (!contained(sessionsRoot, projectPath)) throw new Error(`DSH project escapes sessions root: ${project.name}`);
    for (const nativeSessionId of retainedSessionIds) {
      const sessionPath = join(projectPath, nativeSessionId);
      let sessionInfo;
      try {
        sessionInfo = await lstat(sessionPath);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
        if (code === "ENOENT") continue;
        throw error;
      }
      if (!sessionInfo.isDirectory() || sessionInfo.isSymbolicLink()) {
        throw new Error(`Retained DSH session is not a physical directory: ${nativeSessionId}`);
      }
      const artifactPath = await realpath(join(sessionPath, SESSION_ARTIFACT));
      const artifactInfo = await lstat(artifactPath);
      if (!contained(sessionsRoot, artifactPath) || !artifactInfo.isFile() || artifactInfo.isSymbolicLink()) {
        throw new Error(`Retained DSH artifact is unsafe: ${nativeSessionId}`);
      }
      if (located.has(nativeSessionId)) throw new Error(`Retained DSH session is duplicated: ${nativeSessionId}`);
      located.set(nativeSessionId, { nativeSessionId, artifactPath });
    }
  }
  const missing = [...retainedSessionIds].filter((id) => !located.has(id));
  if (missing.length > 0) throw new Error(`Retained DSH sessions are absent: ${missing.join(", ")}`);
  return [...located.values()].sort((left, right) => left.nativeSessionId.localeCompare(right.nativeSessionId));
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function normalizedAlpha2Envelope(event: DshSessionEvent): JsonValue {
  const envelope = json(event) as { readonly [key: string]: JsonValue };
  const { seq0: _seq0, time0: _time0, ...rest } = envelope;
  return {
    ...rest,
    seq: dshEventSequence(event),
    time: dshEventTime(event),
  };
}

async function canonicalEvents(input: {
  readonly logicalSessionId: LogicalSessionId;
  readonly nativeSessionId: NativeSessionId;
  readonly events: readonly DshSessionEvent[];
  readonly importedAt: string;
  readonly evidencePort: AdapterEvidencePort;
}): Promise<readonly CanonicalEventV1[]> {
  return (await normalizeAlpha2Append({
    runId: "run-canonical-reseed" as RunId,
    operationId: `operation-reseed-${input.nativeSessionId}` as OperationId,
    nativeSessionId: input.nativeSessionId,
    nativeRevision: input.events.length,
    observedAt: input.importedAt,
    payload: {
      logicalSessionId: input.logicalSessionId,
      instanceId: "dsh-alpha2",
      events: input.events.map(normalizedAlpha2Envelope),
    },
  }, input.evidencePort)).events;
}

function eventTitle(events: readonly DshSessionEvent[], fallback: string): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const title = event?.type === "session/title" ? event.data.title : undefined;
    if (typeof title === "string" && title.trim().length > 0) return title.trim();
  }
  return fallback;
}

function timestamp(value: number): string {
  return new Date(value < 1_000_000_000_000 ? value * 1000 : value).toISOString();
}

function workspaceName(cwd: string): string {
  const withoutDevicePrefix = cwd.replace(/^\\\\\?\\/u, "");
  return win32.basename(withoutDevicePrefix) || cwd;
}

function count(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { readonly count: number | bigint };
  return Number(row.count);
}

function candidatePath(stateRoot: string, candidateFile: string): string {
  if (!/^metadata(?:\.[a-z0-9-]+)?\.sqlite$/u.test(candidateFile) || basename(candidateFile) !== candidateFile) {
    throw new TypeError(`Invalid candidate database filename: ${candidateFile}`);
  }
  const root = resolve(stateRoot);
  const target = resolve(root, candidateFile);
  if (!contained(root, target)) throw new Error("Candidate database escapes the Maintenance state root");
  return target;
}

async function fileDigest(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return `sha256:${digest.digest("hex")}`;
}

function verify(database: DatabaseSync, expectedSessions: number): CanonicalReseedManifest["counts"] {
  const integrity = database.prepare("PRAGMA integrity_check").all() as unknown as { readonly integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error(`Candidate database integrity check failed: ${JSON.stringify(integrity)}`);
  }
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length !== 0) throw new Error(`Candidate database has ${foreignKeys.length} foreign-key violations`);
  const counts = {
    logicalSessions: count(database, "logical_sessions"),
    canonicalEvents: count(database, "canonical_events"),
    logicalProjects: count(database, "logical_projects"),
    projectMemberships: count(database, "project_memberships"),
    logicalWorkspaces: count(database, "logical_workspaces"),
    workspaceMemberships: count(database, "workspace_memberships"),
    tombstones: count(database, "session_tombstones"),
  };
  if (counts.logicalSessions !== expectedSessions) {
    throw new Error(`Candidate session count mismatch: expected ${expectedSessions}, got ${counts.logicalSessions}`);
  }
  if (counts.projectMemberships !== counts.logicalSessions || counts.workspaceMemberships !== counts.logicalSessions) {
    throw new Error("Every canonical session must have separate project and workspace membership records");
  }
  if (counts.tombstones !== 0) throw new Error("A clean reseed candidate must not contain delayed-delete tombstones");
  return counts;
}

/**
 * Builds a new canonical database beside the active database. It never mutates
 * the active pointer; activation remains an explicit, separately restartable step.
 */
export async function reseedCanonicalCandidate(input: CanonicalReseedInput): Promise<CanonicalReseedManifest> {
  if (input.retainedDshSessionIds.length === 0) throw new TypeError("At least one retained DSH session is required");
  if (new Set(input.retainedDshSessionIds).size !== input.retainedDshSessionIds.length) {
    throw new TypeError("Retained DSH session IDs must be unique");
  }
  if (input.codexInstance.platform !== "codex") throw new TypeError("Canonical reseed requires a Codex instance");
  const now = input.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const path = candidatePath(input.stateRoot, input.candidateFile);
  try {
    await lstat(path);
    throw new Error(`Refusing to overwrite an existing candidate database: ${path}`);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
    if (code !== "ENOENT") throw error;
  }
  await input.onStatus?.({ stage: "reseed.candidate.open", state: "started", detail: path });
  const database = openMaintenanceDatabase(path);
  const objectStore = new ZstdContentObjectStore(input.stateRoot);
  const evidenceStore = new SqliteAdapterEvidenceStore(database, objectStore, { clock: () => createdAt });
  const store = new SqliteCanonicalSessionEngineStore(database, objectStore);
  const engine = new CanonicalSessionEngine(store);
  const repository = new SqliteCanonicalRepository(database);
  try {
    await input.onStatus?.({ stage: "reseed.candidate.open", state: "succeeded", detail: path });
    const projectId = `project-maintenance-${sha256Canonical({
      name: input.maintenanceProjectName,
      root: normalizeCodexProjectPath(input.maintenanceProjectRoot),
    }).slice(0, 24)}` as LogicalProjectId;
    await repository.upsertLogicalProject({
      schemaVersion: 1,
      id: projectId,
      name: input.maintenanceProjectName,
      sourcePlatform: "maintenance",
      sourceProjectId: null,
      sortKey: `${input.maintenanceProjectName}\0${projectId}`,
      deletedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    await repository.replaceProjectRoots(projectId, [{
      schemaVersion: 1,
      projectId,
      path: input.maintenanceProjectRoot,
      normalizedPath: normalizeCodexProjectPath(input.maintenanceProjectRoot),
      ordinal: 0,
    }]);

    await input.onStatus?.({ stage: "reseed.dsh.read", state: "started", detail: `${input.retainedDshSessionIds.length} sessions` });
    const located = await locateDshSessions(input.dshHome, new Set(input.retainedDshSessionIds));
    await input.onStatus?.({ stage: "reseed.dsh.read", state: "succeeded", detail: `${located.length} sessions` });
    let dshImported = 0;
    for (const item of located) {
      await input.onStatus?.({ stage: "reseed.dsh.import", state: "started", detail: item.nativeSessionId });
      const decoded = decodeDshArtifact(await readFile(item.artifactPath));
      if (decoded.header.id !== item.nativeSessionId) {
        throw new Error(`DSH header identity mismatch: ${item.nativeSessionId}/${decoded.header.id}`);
      }
      const logicalSessionId = logicalSessionIdFor({
        platform: "dsh",
        instanceId: input.dshInstanceId,
        sessionId: item.nativeSessionId,
      }) as LogicalSessionId;
      const workspaceId = `workspace_${sha256Canonical({
        authority: "maintenance",
        cwd: normalizeCodexProjectPath(decoded.header.cwd),
      }).slice(0, 24)}` as LogicalWorkspaceId;
      await repository.upsertLogicalWorkspace({
        schemaVersion: 1,
        id: workspaceId,
        parentId: null,
        name: workspaceName(decoded.header.cwd),
        sortKey: decoded.header.cwd,
        deletedAt: null,
        createdAt: timestamp(decoded.header.createdAt),
        updatedAt: createdAt,
      });
      const receipt = await engine.importDshNative({
        operationId: `operation-reseed-${item.nativeSessionId}` as OperationId,
        logicalSessionId,
        nativeSessionId: item.nativeSessionId as NativeSessionId,
        title: eventTitle(decoded.events, item.nativeSessionId),
        tags: ["maintenance-native", "dsh-obsidian-test"],
        archivedAt: null,
        workspaceId,
        events: await canonicalEvents({
          logicalSessionId,
          nativeSessionId: item.nativeSessionId as NativeSessionId,
          events: decoded.events,
          importedAt: createdAt,
          evidencePort: evidenceStore,
        }),
        importedAt: createdAt,
      });
      if (receipt.outcome !== "created") throw new Error(`Fresh DSH import was not created: ${item.nativeSessionId}`);
      await repository.setProjectMembership({
        schemaVersion: 1,
        logicalSessionId,
        projectId,
        revision: 0,
      });
      dshImported += 1;
      await input.onStatus?.({ stage: "reseed.dsh.import", state: "succeeded", detail: item.nativeSessionId });
    }

    await input.onStatus?.({ stage: "reseed.codex.import", state: "started", detail: input.codexInstance.root });
    const codex = await new CodexCanonicalImportService({
      canonicalEngine: engine,
      projectPort: new SqliteCodexProjectPort(repository),
      evidencePort: evidenceStore,
      ...(input.fixtureGuard === undefined ? {} : { fixtureGuard: input.fixtureGuard }),
    }).sync({
      instance: input.codexInstance,
      onStatus: (status) => input.onStatus?.({
        stage: "reseed.codex.session",
        state: status.state === "retry" ? "started" : "succeeded",
        detail: `${status.stage}; session=${status.sessionId ?? "catalog"}; ${status.detail}`,
      }),
    });
    if (input.expectedCodexSessions !== undefined && codex.scanned !== input.expectedCodexSessions) {
      throw new Error(`Codex hot snapshot count changed: expected ${input.expectedCodexSessions}, got ${codex.scanned}`);
    }
    if (codex.retried !== 0) throw new Error(`Codex hot import left ${codex.retried} unstable sessions`);
    await input.onStatus?.({ stage: "reseed.codex.import", state: "succeeded", detail: `${codex.scanned} sessions` });

    await input.onStatus?.({ stage: "reseed.verify", state: "started", detail: path });
    const counts = verify(database, dshImported + codex.scanned);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    await input.onStatus?.({ stage: "reseed.verify", state: "succeeded", detail: `${counts.logicalSessions} sessions` });
    database.close();
    const manifest: CanonicalReseedManifest = {
      schemaVersion: 1,
      createdAt,
      candidatePath: path,
      candidateDigest: await fileDigest(path),
      retainedDshSessionIds: [...input.retainedDshSessionIds],
      dshImported,
      codex,
      counts,
      integrityCheck: "ok",
      foreignKeyViolations: 0,
    };
    await writeFile(`${path}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return manifest;
  } catch (error) {
    try { database.close(); } catch { /* preserve the reseed failure */ }
    throw error;
  }
}
