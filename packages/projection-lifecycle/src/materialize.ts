import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type {
  JsonValue,
  NativeSessionId,
  ProjectionManifest,
  ProjectionReader,
  ProjectionWriter,
} from "@linmu/dsh-session-adapter-sdk";
import type { RunId } from "@linmu/dsh-session-contracts";

export type {
  CanonicalProjectionSource,
  IncrementalCanonicalProjectionSource,
} from "@linmu/dsh-session-contracts";

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
const BASE_PROJECTION_FILE = "base-projection.json";

interface BaseProjectionPointer {
  readonly schemaVersion: 1;
  readonly root: string;
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
  private baseRoot: string | null | undefined;

  constructor(root: string) {
    this.root = root;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(join(this.root, "sessions"), { recursive: true }),
      mkdir(join(this.root, "workspaces"), { recursive: true }),
    ]);
  }

  /** Makes this run-local directory a sparse writable overlay over a retained cache. */
  async bindBaseProjection(baseRoot: string): Promise<void> {
    const normalized = resolve(baseRoot);
    if (normalized === this.root) throw new TypeError("Projection overlay cannot reference itself as its base");
    await access(normalized);
    await this.writeJsonAtomically(join(this.root, BASE_PROJECTION_FILE), {
      schemaVersion: 1,
      root: normalized,
    });
    this.baseRoot = normalized;
  }

  async baseProjectionRoot(): Promise<string | null> {
    if (this.baseRoot !== undefined) return this.baseRoot;
    try {
      const value = JSON.parse(await readFile(join(this.root, BASE_PROJECTION_FILE), "utf8")) as BaseProjectionPointer;
      if (value.schemaVersion !== 1 || typeof value.root !== "string" || value.root.length === 0) {
        throw new TypeError("Projection base pointer is invalid");
      }
      const normalized = resolve(value.root);
      if (normalized === this.root) throw new TypeError("Projection overlay base pointer is recursive");
      this.baseRoot = normalized;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.baseRoot = null;
    }
    return this.baseRoot;
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
      const base = await this.baseDirectory();
      return base === undefined ? this.rebuildSessionCatalog(runId) : base.readSessionCatalog(runId);
    }
  }

  async replaceSessionCatalog(sidecar: ProjectionRuntimeCatalogSidecar): Promise<void> {
    const validated = parseCatalog(sidecar, sidecar.runId);
    await this.writeJsonAtomically(join(this.root, SESSION_CATALOG_FILE), validated as unknown as JsonValue);
  }

  /** Returns a run-bound catalog copy without mutating this retained projection. */
  async snapshotSessionCatalog(runId: RunId): Promise<ProjectionRuntimeCatalogSidecar> {
    const raw = JSON.parse(await readFile(join(this.root, SESSION_CATALOG_FILE), "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !("runId" in raw) || typeof raw.runId !== "string") {
      throw new TypeError("Projection session catalog header is invalid");
    }
    const current = parseCatalog(raw, raw.runId as RunId);
    return { ...current, runId };
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

  /** Session entries owned by this directory, excluding its shared cache. */
  async listLocalNativeSessionIds(): Promise<readonly NativeSessionId[]> {
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

  async listNativeSessionIds(): Promise<readonly NativeSessionId[]> {
    const localIds = await this.listLocalNativeSessionIds();
    const base = await this.baseDirectory();
    return [...new Set([
      ...localIds,
      ...(base === undefined ? [] : await base.listNativeSessionIds()),
    ])].sort();
  }

  async readSession(nativeSessionId: NativeSessionId): Promise<JsonValue> {
    try {
      return JSON.parse(
        await readFile(join(this.root, "sessions", `${encoded(nativeSessionId)}.json`), "utf8"),
      ) as JsonValue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const base = await this.baseDirectory();
      if (base === undefined) throw error;
      return base.readSession(nativeSessionId);
    }
  }

  async readWorkspace(nativeWorkspaceId: string): Promise<JsonValue> {
    try {
      return JSON.parse(
        await readFile(join(this.root, "workspaces", `${encoded(nativeWorkspaceId)}.json`), "utf8"),
      ) as JsonValue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const base = await this.baseDirectory();
      if (base === undefined) throw error;
      return base.readWorkspace(nativeWorkspaceId);
    }
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
    const base = await this.baseDirectory();
    return [...new Set([
      ...this.workspaceIds,
      ...(base === undefined ? [] : await base.listNativeWorkspaceIds()),
    ])].sort();
  }

  async writeManifest(manifest: ProjectionManifest): Promise<void> {
    await this.writeJson(join(this.root, "projection-manifest.json"), manifest as unknown as JsonValue);
  }

  async replaceManifest(manifest: ProjectionManifest): Promise<void> {
    await this.writeJsonAtomically(join(this.root, "projection-manifest.json"), manifest as unknown as JsonValue);
  }

  async readManifest(): Promise<ProjectionManifest> {
    try {
      return JSON.parse(await readFile(join(this.root, "projection-manifest.json"), "utf8")) as ProjectionManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const base = await this.baseDirectory();
      if (base === undefined) throw error;
      return base.readManifest();
    }
  }

  private async baseDirectory(): Promise<JsonProjectionDirectory | undefined> {
    const baseRoot = await this.baseProjectionRoot();
    return baseRoot === null ? undefined : new JsonProjectionDirectory(baseRoot);
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
