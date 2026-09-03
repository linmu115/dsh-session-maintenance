import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type {
  CanonicalEventV1,
  CanonicalProjectionInput,
  CanonicalSessionRecord,
  JsonValue,
  LogicalWorkspace,
  NativeSessionId,
  ProjectionManifest,
  ProjectionReader,
  ProjectionRun,
  ProjectionWriter,
} from "@linmu/dsh-session-adapter-sdk";
import type {
  CanonicalChangePage,
  CanonicalChangeQuery,
  CanonicalChangeV1,
  LogicalSessionId,
  RunId,
} from "@linmu/dsh-session-contracts";
import {
  canonicalChangePageSchema,
  canonicalChangeQuerySchema,
  canonicalEventV1Schema,
  canonicalSessionRecordSchema,
  logicalWorkspaceSchema,
  type ContentObjectStore,
} from "@linmu/dsh-session-contracts";

export interface CanonicalProjectionSource {
  load(run: ProjectionRun): Promise<CanonicalProjectionInput>;
}

export interface IncrementalCanonicalProjectionSource extends CanonicalProjectionSource {
  currentRevision(): Promise<number>;
  listChanges(input: CanonicalChangeQuery): Promise<CanonicalChangePage>;
  loadSessions(run: ProjectionRun, logicalSessionIds: readonly LogicalSessionId[]): Promise<CanonicalProjectionInput>;
}

export interface ProjectionRuntimeSnapshot {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly sessions: readonly {
    readonly nativeSessionId: NativeSessionId;
    readonly payload: JsonValue;
  }[];
}

export interface ProjectionRuntimeCatalogEntry {
  readonly nativeSessionId: NativeSessionId;
  readonly updatedAt: string;
  readonly eventCount: number;
  /** Complete projected session metadata with an empty events array. */
  readonly payload: JsonValue;
}

export interface ProjectionRuntimeCatalogSidecar {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly sessions: readonly ProjectionRuntimeCatalogEntry[];
}

const SESSION_CATALOG_FILE = "session-catalog.json";

export function projectionRootFor(runtimeRoot: string, runId: RunId): string {
  const root = resolve(runtimeRoot);
  return join(root, "runs", Buffer.from(runId, "utf8").toString("base64url"), "projection");
}

export async function readProjectionRuntimeSnapshot(
  runtimeRoot: string,
  runId: RunId,
): Promise<ProjectionRuntimeSnapshot> {
  const directory = new JsonProjectionDirectory(projectionRootFor(runtimeRoot, runId));
  const ids = await directory.listNativeSessionIds();
  return {
    schemaVersion: 1,
    runId,
    sessions: await Promise.all(ids.map(async (nativeSessionId) => ({
      nativeSessionId,
      payload: await directory.readSession(nativeSessionId),
    }))),
  };
}

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function objectPayload(value: JsonValue): { readonly [key: string]: JsonValue } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Projection session payload must be an object");
  }
  return value as { readonly [key: string]: JsonValue };
}

function catalogEntry(
  nativeSessionId: NativeSessionId,
  payload: JsonValue,
  canonicalUpdatedAt?: string,
): ProjectionRuntimeCatalogEntry {
  const record = objectPayload(payload);
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : canonicalUpdatedAt;
  const events = record.events;
  if (typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))) {
    throw new TypeError(`Projection session ${nativeSessionId} has no valid updatedAt metadata`);
  }
  if (!Array.isArray(events)) {
    throw new TypeError(`Projection session ${nativeSessionId} has no events array`);
  }
  return {
    nativeSessionId,
    updatedAt,
    eventCount: events.length,
    payload: { ...record, events: [] },
  };
}

function sortCatalog(entries: readonly ProjectionRuntimeCatalogEntry[]): ProjectionRuntimeCatalogEntry[] {
  return [...entries].sort((left, right) => {
    const byUpdatedAt = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    return byUpdatedAt === 0
      ? left.nativeSessionId.localeCompare(right.nativeSessionId)
      : byUpdatedAt;
  });
}

function parseCatalog(value: unknown, expectedRunId: RunId): ProjectionRuntimeCatalogSidecar {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Projection session catalog is invalid");
  }
  const record = value as { readonly schemaVersion?: unknown; readonly runId?: unknown; readonly sessions?: unknown };
  if (record.schemaVersion !== 1 || record.runId !== expectedRunId || !Array.isArray(record.sessions)) {
    throw new TypeError("Projection session catalog header is invalid");
  }
  const sessions = record.sessions.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError("Projection session catalog entry is invalid");
    }
    const entry = item as {
      readonly nativeSessionId?: unknown;
      readonly updatedAt?: unknown;
      readonly eventCount?: unknown;
      readonly payload?: unknown;
    };
    if (
      typeof entry.nativeSessionId !== "string"
      || typeof entry.updatedAt !== "string"
      || !Number.isFinite(Date.parse(entry.updatedAt))
      || !Number.isSafeInteger(entry.eventCount)
      || (entry.eventCount as number) < 0
      || entry.payload === undefined
    ) throw new TypeError("Projection session catalog entry fields are invalid");
    return {
      nativeSessionId: entry.nativeSessionId as NativeSessionId,
      updatedAt: entry.updatedAt,
      eventCount: entry.eventCount as number,
      payload: entry.payload as JsonValue,
    };
  });
  return { schemaVersion: 1, runId: expectedRunId, sessions: sortCatalog(sessions) };
}

export class JsonProjectionDirectory implements ProjectionWriter, ProjectionReader {
  readonly root: string;
  private readonly sessionIds = new Set<NativeSessionId>();
  private readonly workspaceIds = new Set<string>();
  private catalogMutation: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.root = root;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(join(this.root, "sessions"), { recursive: true }),
      mkdir(join(this.root, "workspaces"), { recursive: true }),
    ]);
  }

  async writeWorkspace(nativeWorkspaceId: string, payload: JsonValue): Promise<void> {
    await this.writeJson(join(this.root, "workspaces", `${encoded(nativeWorkspaceId)}.json`), payload);
    this.workspaceIds.add(nativeWorkspaceId);
    await this.writeJson(join(this.root, "workspace-index.json"), [...this.workspaceIds].sort(), false);
  }

  async replaceWorkspace(nativeWorkspaceId: string, payload: JsonValue): Promise<void> {
    await this.listNativeWorkspaceIds();
    const existed = this.workspaceIds.has(nativeWorkspaceId);
    await this.writeJsonAtomically(join(this.root, "workspaces", `${encoded(nativeWorkspaceId)}.json`), payload);
    this.workspaceIds.add(nativeWorkspaceId);
    if (!existed) {
      await this.writeJsonAtomically(join(this.root, "workspace-index.json"), [...this.workspaceIds].sort());
    }
  }

  async removeWorkspace(nativeWorkspaceId: string): Promise<boolean> {
    await this.listNativeWorkspaceIds();
    if (!this.workspaceIds.delete(nativeWorkspaceId)) return false;
    await rm(join(this.root, "workspaces", `${encoded(nativeWorkspaceId)}.json`), { force: true });
    await this.writeJsonAtomically(join(this.root, "workspace-index.json"), [...this.workspaceIds].sort());
    return true;
  }

  async writeSession(nativeSessionId: NativeSessionId, payload: JsonValue): Promise<void> {
    await this.writeJson(join(this.root, "sessions", `${encoded(nativeSessionId)}.json`), payload);
    this.sessionIds.add(nativeSessionId);
    await this.writeJson(join(this.root, "session-index.json"), [...this.sessionIds].sort(), false);
    await this.updateCatalogIfPresent(nativeSessionId, payload);
  }

  async replaceSession(nativeSessionId: NativeSessionId, payload: JsonValue): Promise<void> {
    await this.listNativeSessionIds();
    const existed = this.sessionIds.has(nativeSessionId);
    const path = join(this.root, "sessions", `${encoded(nativeSessionId)}.json`);
    await this.writeJsonAtomically(path, payload);
    this.sessionIds.add(nativeSessionId);
    if (!existed) {
      await this.writeJsonAtomically(join(this.root, "session-index.json"), [...this.sessionIds].sort());
    }
    await this.updateCatalogIfPresent(nativeSessionId, payload);
  }

  async removeSession(nativeSessionId: NativeSessionId): Promise<boolean> {
    await this.listNativeSessionIds();
    if (!this.sessionIds.delete(nativeSessionId)) return false;
    await rm(join(this.root, "sessions", `${encoded(nativeSessionId)}.json`), { force: true });
    await this.writeJsonAtomically(join(this.root, "session-index.json"), [...this.sessionIds].sort());
    await this.removeCatalogEntryIfPresent(nativeSessionId);
    return true;
  }

  async rebuildSessionCatalog(
    runId: RunId,
    canonicalUpdatedAtByNativeSessionId: ReadonlyMap<string, string> = new Map(),
  ): Promise<ProjectionRuntimeCatalogSidecar> {
    const sessions: ProjectionRuntimeCatalogEntry[] = [];
    for (const nativeSessionId of await this.listNativeSessionIds()) {
      sessions.push(catalogEntry(
        nativeSessionId,
        await this.readSession(nativeSessionId),
        canonicalUpdatedAtByNativeSessionId.get(nativeSessionId),
      ));
    }
    const sidecar: ProjectionRuntimeCatalogSidecar = {
      schemaVersion: 1,
      runId,
      sessions: sortCatalog(sessions),
    };
    await this.writeJsonAtomically(join(this.root, SESSION_CATALOG_FILE), sidecar as unknown as JsonValue);
    return sidecar;
  }

  async readSessionCatalog(runId: RunId): Promise<ProjectionRuntimeCatalogSidecar> {
    try {
      return parseCatalog(JSON.parse(await readFile(join(this.root, SESSION_CATALOG_FILE), "utf8")), runId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.rebuildSessionCatalog(runId);
    }
  }

  async rebindSessionCatalog(runId: RunId): Promise<ProjectionRuntimeCatalogSidecar> {
    try {
      const raw = JSON.parse(await readFile(join(this.root, SESSION_CATALOG_FILE), "utf8")) as unknown;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !("runId" in raw) || typeof raw.runId !== "string") {
        throw new TypeError("Projection session catalog header is invalid");
      }
      const current = parseCatalog(raw, raw.runId as RunId);
      const rebound = { ...current, runId };
      await this.writeJsonAtomically(join(this.root, SESSION_CATALOG_FILE), rebound as unknown as JsonValue);
      return rebound;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.rebuildSessionCatalog(runId);
    }
  }

  async listNativeSessionIds(): Promise<readonly NativeSessionId[]> {
    if (this.sessionIds.size === 0) {
      try {
        const ids = JSON.parse(await readFile(join(this.root, "session-index.json"), "utf8")) as unknown;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
          throw new TypeError("Projection session index is invalid");
        }
        for (const id of ids) this.sessionIds.add(id as NativeSessionId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return [...this.sessionIds].sort();
  }

  async readSession(nativeSessionId: NativeSessionId): Promise<JsonValue> {
    return JSON.parse(
      await readFile(join(this.root, "sessions", `${encoded(nativeSessionId)}.json`), "utf8"),
    ) as JsonValue;
  }

  async readWorkspace(nativeWorkspaceId: string): Promise<JsonValue> {
    return JSON.parse(
      await readFile(join(this.root, "workspaces", `${encoded(nativeWorkspaceId)}.json`), "utf8"),
    ) as JsonValue;
  }

  async listNativeWorkspaceIds(): Promise<readonly string[]> {
    if (this.workspaceIds.size === 0) {
      try {
        const ids = JSON.parse(await readFile(join(this.root, "workspace-index.json"), "utf8")) as unknown;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
          throw new TypeError("Projection workspace index is invalid");
        }
        for (const id of ids) this.workspaceIds.add(id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return [...this.workspaceIds].sort();
  }

  async writeManifest(manifest: ProjectionManifest): Promise<void> {
    await this.writeJson(join(this.root, "projection-manifest.json"), manifest as unknown as JsonValue);
  }

  async replaceManifest(manifest: ProjectionManifest): Promise<void> {
    await this.writeJsonAtomically(join(this.root, "projection-manifest.json"), manifest as unknown as JsonValue);
  }

  async readManifest(): Promise<ProjectionManifest> {
    return JSON.parse(await readFile(join(this.root, "projection-manifest.json"), "utf8")) as ProjectionManifest;
  }

  private async writeJson(path: string, value: JsonValue, exclusive = true): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: exclusive ? "wx" : "w" });
  }

  private async writeJsonAtomically(path: string, value: JsonValue): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.projection-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async updateCatalogIfPresent(nativeSessionId: NativeSessionId, payload: JsonValue): Promise<void> {
    const mutation = this.catalogMutation.catch(() => undefined).then(async () => {
      let current: ProjectionRuntimeCatalogSidecar;
      try {
        const raw = JSON.parse(await readFile(join(this.root, SESSION_CATALOG_FILE), "utf8")) as unknown;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !("runId" in raw) || typeof raw.runId !== "string") {
          throw new TypeError("Projection session catalog header is invalid");
        }
        current = parseCatalog(raw, raw.runId as RunId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const nextEntry = catalogEntry(nativeSessionId, payload);
      const sessions = current.sessions.filter((entry) => entry.nativeSessionId !== nativeSessionId);
      sessions.push(nextEntry);
      await this.writeJsonAtomically(join(this.root, SESSION_CATALOG_FILE), {
        ...current,
        sessions: sortCatalog(sessions),
      } as unknown as JsonValue);
    });
    this.catalogMutation = mutation;
    await mutation;
  }

  private async removeCatalogEntryIfPresent(nativeSessionId: NativeSessionId): Promise<void> {
    const mutation = this.catalogMutation.catch(() => undefined).then(async () => {
      let current: ProjectionRuntimeCatalogSidecar;
      try {
        const raw = JSON.parse(await readFile(join(this.root, SESSION_CATALOG_FILE), "utf8")) as unknown;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !("runId" in raw) || typeof raw.runId !== "string") {
          throw new TypeError("Projection session catalog header is invalid");
        }
        current = parseCatalog(raw, raw.runId as RunId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      await this.writeJsonAtomically(join(this.root, SESSION_CATALOG_FILE), {
        ...current,
        sessions: current.sessions.filter((entry) => entry.nativeSessionId !== nativeSessionId),
      } as unknown as JsonValue);
    });
    this.catalogMutation = mutation;
    await mutation;
  }
}

interface SessionRow {
  readonly id: string;
  readonly display_title: string;
  readonly labels_json: string;
  readonly authority_scope: CanonicalSessionRecord["authorityScope"];
  readonly origin_kind: CanonicalSessionRecord["originKind"];
  readonly head_version_id: string | null;
  readonly archived_at: string | null;
  readonly tombstoned_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly workspace_id: string | null;
  readonly project_id: string | null;
  readonly project_name: string | null;
  readonly project_root: string | null;
}

interface WorkspaceRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly sort_key: string;
  readonly deleted_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface EventRow { readonly event_json: string }

export class SqliteCanonicalProjectionSource implements IncrementalCanonicalProjectionSource {
  readonly database: DatabaseSync;
  readonly objectStore: ContentObjectStore | undefined;

  constructor(database: DatabaseSync, objectStore?: ContentObjectStore) {
    this.database = database;
    this.objectStore = objectStore;
  }

  async load(run: ProjectionRun): Promise<CanonicalProjectionInput> {
    return this.loadSelection(run);
  }

  async loadSessions(
    run: ProjectionRun,
    logicalSessionIds: readonly LogicalSessionId[],
  ): Promise<CanonicalProjectionInput> {
    return this.loadSelection(run, logicalSessionIds);
  }

  async currentRevision(): Promise<number> {
    const row = this.database.prepare(
      "SELECT COALESCE(MAX(revision), 0) AS revision FROM canonical_change_log",
    ).get() as { readonly revision: number };
    return row.revision;
  }

  async listChanges(input: CanonicalChangeQuery): Promise<CanonicalChangePage> {
    canonicalChangeQuerySchema.parse(input);
    const currentRevision = await this.currentRevision();
    if (input.afterRevision > currentRevision) {
      throw new Error(`Canonical change cursor ${input.afterRevision} exceeds current revision ${currentRevision}`);
    }
    const rows = this.database.prepare(
      `SELECT revision, logical_session_id, change_kind, changed_at
       FROM canonical_change_log
       WHERE revision > ? AND revision <= ?
       ORDER BY revision
       LIMIT ?`,
    ).all(input.afterRevision, currentRevision, input.limit) as unknown as Array<{
      readonly revision: number;
      readonly logical_session_id: string;
      readonly change_kind: CanonicalChangeV1["kind"];
      readonly changed_at: string;
    }>;
    const changes: CanonicalChangeV1[] = rows.map((row) => ({
      schemaVersion: 1,
      revision: row.revision,
      logicalSessionId: row.logical_session_id as LogicalSessionId,
      kind: row.change_kind,
      changedAt: row.changed_at,
    }));
    const throughRevision = changes.at(-1)?.revision ?? input.afterRevision;
    return canonicalChangePageSchema.parse({
      schemaVersion: 1,
      afterRevision: input.afterRevision,
      throughRevision,
      currentRevision,
      hasMore: throughRevision < currentRevision,
      changes,
    }) as unknown as CanonicalChangePage;
  }

  private async loadSelection(
    run: ProjectionRun,
    logicalSessionIds?: readonly LogicalSessionId[],
  ): Promise<CanonicalProjectionInput> {
    const workspaceRows = this.database.prepare(
      `SELECT id, parent_id, name, sort_key, deleted_at, created_at, updated_at
       FROM logical_workspaces WHERE deleted_at IS NULL ORDER BY sort_key, id`,
    ).all() as unknown as WorkspaceRow[];
    const workspaces = workspaceRows.map((row) => logicalWorkspaceSchema.parse({
      schemaVersion: 1,
      id: row.id,
      parentId: row.parent_id,
      name: row.name,
      sortKey: row.sort_key,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }) as unknown as LogicalWorkspace);
    const existingWorkspaces = new Set(workspaces.map((workspace) => workspace.id));
    if (logicalSessionIds !== undefined && logicalSessionIds.length === 0) {
      return { run, workspaces, sessions: [] };
    }
    const selectionClause = logicalSessionIds === undefined
      ? ""
      : ` AND s.id IN (${logicalSessionIds.map(() => "?").join(",")})`;
    const sessionRows = this.database.prepare(
      `SELECT s.id, s.display_title, s.labels_json, s.authority_scope, s.origin_kind,
              s.head_version_id, s.archived_at, s.tombstoned_at, s.created_at, s.updated_at,
               m.workspace_id,
               p.id AS project_id,
               p.name AS project_name,
               (SELECT r.root_path
                  FROM project_roots r
                 WHERE r.project_id = p.id
                 ORDER BY r.ordinal, r.normalized_root_path
                 LIMIT 1) AS project_root
       FROM logical_sessions s
       LEFT JOIN workspace_memberships m ON m.logical_session_id = s.id
       LEFT JOIN project_memberships pm ON pm.logical_session_id = s.id
       LEFT JOIN logical_projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
       WHERE s.authority_scope IS NOT NULL
         AND s.origin_kind IS NOT NULL
         AND s.updated_at IS NOT NULL
         AND s.tombstoned_at IS NULL
         ${selectionClause}
       ORDER BY s.created_at, s.id`,
    ).all(...(logicalSessionIds ?? [])) as unknown as SessionRow[];
    const sessions = await Promise.all(sessionRows.map(async (row) => {
      const session = canonicalSessionRecordSchema.parse({
        schemaVersion: 1,
        id: row.id,
        authorityScope: row.authority_scope,
        originKind: row.origin_kind,
        headVersionId: row.head_version_id,
        title: row.display_title,
        tags: JSON.parse(row.labels_json) as unknown,
        archivedAt: row.archived_at,
        tombstonedAt: row.tombstoned_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }) as unknown as CanonicalSessionRecord;
      const events = await this.loadHeadEvents(row.id, row.head_version_id);
      return {
        session,
        events,
        workspaceId: row.workspace_id !== null && existingWorkspaces.has(row.workspace_id as never)
          ? row.workspace_id as never
          : null,
        projectId: row.project_id as never,
        projectName: row.project_name,
        projectRoot: row.project_root,
      };
    }));
    return { run, workspaces, sessions };
  }

  private async loadHeadEvents(
    logicalSessionId: string,
    headVersionId: string | null,
  ): Promise<readonly CanonicalEventV1[]> {
    if (headVersionId !== null && this.objectStore !== undefined) {
      const version = this.database.prepare(
        "SELECT body_object FROM session_versions WHERE id = ? AND logical_session_id = ?",
      ).get(headVersionId, logicalSessionId) as { readonly body_object: string } | undefined;
      if (version === undefined) {
        throw new Error(`Canonical projection head is missing: ${logicalSessionId}/${headVersionId}`);
      }
      const body = JSON.parse(
        Buffer.from(await this.objectStore.get(version.body_object)).toString("utf8"),
      ) as { readonly schemaVersion?: unknown; readonly events?: unknown };
      if (body.schemaVersion !== 1 || !Array.isArray(body.events)) {
        throw new Error(`Canonical projection body is invalid: ${logicalSessionId}/${headVersionId}`);
      }
      return body.events.map((event) => canonicalEventV1Schema.parse(event) as unknown as CanonicalEventV1);
    }
    const eventRows = this.database.prepare(
      `SELECT event_json FROM canonical_events
       WHERE logical_session_id = ? ORDER BY sequence`,
    ).all(logicalSessionId) as unknown as EventRow[];
    return eventRows.map((eventRow) => canonicalEventV1Schema.parse(
      JSON.parse(eventRow.event_json),
    ) as unknown as CanonicalEventV1);
  }
}
