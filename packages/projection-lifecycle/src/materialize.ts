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
import type { RunId } from "@linmu/dsh-session-contracts";
import {
  canonicalEventV1Schema,
  canonicalSessionRecordSchema,
  logicalWorkspaceSchema,
} from "@linmu/dsh-session-contracts";

export interface CanonicalProjectionSource {
  load(run: ProjectionRun): Promise<CanonicalProjectionInput>;
}

export interface ProjectionRuntimeSnapshot {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly sessions: readonly {
    readonly nativeSessionId: NativeSessionId;
    readonly payload: JsonValue;
  }[];
}

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

export class JsonProjectionDirectory implements ProjectionWriter, ProjectionReader {
  readonly root: string;
  private readonly sessionIds = new Set<NativeSessionId>();
  private readonly workspaceIds = new Set<string>();

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

  async writeSession(nativeSessionId: NativeSessionId, payload: JsonValue): Promise<void> {
    await this.writeJson(join(this.root, "sessions", `${encoded(nativeSessionId)}.json`), payload);
    this.sessionIds.add(nativeSessionId);
    await this.writeJson(join(this.root, "session-index.json"), [...this.sessionIds].sort(), false);
  }

  async replaceSession(nativeSessionId: NativeSessionId, payload: JsonValue): Promise<void> {
    const path = join(this.root, "sessions", `${encoded(nativeSessionId)}.json`);
    await this.writeJsonAtomically(path, payload);
    this.sessionIds.add(nativeSessionId);
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

  private async writeJson(path: string, value: JsonValue, exclusive = true): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: exclusive ? "wx" : "w" });
  }

  private async writeJsonAtomically(path: string, value: JsonValue): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
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

export class SqliteCanonicalProjectionSource implements CanonicalProjectionSource {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async load(run: ProjectionRun): Promise<CanonicalProjectionInput> {
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
    const sessionRows = this.database.prepare(
      `SELECT s.id, s.display_title, s.labels_json, s.authority_scope, s.origin_kind,
              s.head_version_id, s.archived_at, s.tombstoned_at, s.created_at, s.updated_at,
              m.workspace_id
       FROM logical_sessions s
       LEFT JOIN workspace_memberships m ON m.logical_session_id = s.id
       WHERE s.authority_scope IS NOT NULL
         AND s.origin_kind IS NOT NULL
         AND s.updated_at IS NOT NULL
         AND s.tombstoned_at IS NULL
       ORDER BY s.created_at, s.id`,
    ).all() as unknown as SessionRow[];
    const sessions = sessionRows.map((row) => {
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
      const eventRows = this.database.prepare(
        `SELECT event_json FROM canonical_events
         WHERE logical_session_id = ? ORDER BY sequence`,
      ).all(row.id) as unknown as EventRow[];
      const events = eventRows.map((eventRow) => canonicalEventV1Schema.parse(
        JSON.parse(eventRow.event_json),
      ) as unknown as CanonicalEventV1);
      return {
        session,
        events,
        workspaceId: row.workspace_id !== null && existingWorkspaces.has(row.workspace_id as never)
          ? row.workspace_id as never
          : null,
      };
    });
    return { run, workspaces, sessions };
  }
}
