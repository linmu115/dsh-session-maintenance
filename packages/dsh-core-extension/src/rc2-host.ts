import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { canonicalJson } from "@linmu/dsh-session-domain";

import type {
  DshCoreHost,
  DshNativeEvent,
  DshNativeSessionHeader,
  DshProjectionSnapshot,
  DshRuntimeSnapshot,
  DshSessionArtifactCapture,
  DshSessionArtifactSnapshot,
  DshWorkspaceSnapshot,
  Rc2CoreContractObservation,
} from "./types.js";

interface Rc2PersistenceCoordinator {
  readonly states: Map<string, unknown>;
  readonly preparations: { invalidate(id: string): void };
  serialize<T>(id: string, operation: () => Promise<T>): Promise<T>;
}

interface Rc2SessionPersistence {
  readonly coordinator: Rc2PersistenceCoordinator;
  list(): Promise<readonly DshNativeSessionHeader[]>;
  inspect(id: string): Promise<{
    readonly meta: DshNativeSessionHeader;
    readonly events: readonly DshNativeEvent[];
  }>;
  locate(meta: DshNativeSessionHeader): { readonly kind: "jsonl"; readonly path: string };
  create(meta: DshNativeSessionHeader): Promise<void>;
  append(id: string, events: readonly DshNativeEvent[]): Promise<void>;
}

interface Rc2WorkspaceEntity {
  readonly id: string;
  readonly sessionIds: readonly string[];
  attachSession(sessionId: string): Promise<void>;
  detachSession(sessionId: string): Promise<void>;
  insertSessionBefore(sessionId: string, beforeSessionId?: string): Promise<void>;
}

interface Rc2WorkspaceRegistry {
  readonly archivedSessionIds: readonly string[];
  readonly state: {
    readonly initialized: boolean;
    readonly workspaceIds: readonly string[];
    readonly archivedSessionIds: readonly string[];
  };
  list(): readonly Rc2WorkspaceEntity[];
  get(id: string): Rc2WorkspaceEntity | undefined;
  archiveSession(id: string): Promise<void>;
  setState(state: Rc2WorkspaceRegistry["state"]): Promise<void>;
  enqueueOperation<T>(operation: () => Promise<T>): Promise<T>;
  replaceHeaderIndex(headers: readonly DshNativeSessionHeader[]): Promise<void>;
}

interface Rc2ProjectionTable {
  get(id: string): unknown;
  put(id: string, value: unknown): Promise<void>;
  delete(id: string): Promise<void>;
}

interface Rc2ProjectionCache {
  readonly table: Rc2ProjectionTable;
}

interface Rc2QueryEngine {
  readonly _db?: DatabaseSync;
  _ensureReady(signal?: AbortSignal): Promise<void>;
  _reconcile(signal?: AbortSignal): Promise<unknown>;
  _serialized<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T>;
}

export interface Rc2RuntimeContext {
  readonly sessions: { get(id: string): unknown };
  readonly sessionPersistence: Rc2SessionPersistence;
  readonly workspaceRegistry: Rc2WorkspaceRegistry;
  readonly sessionProjectionCache: Rc2ProjectionCache;
  readonly sessionQuery: Rc2QueryEngine;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value as never)).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function atomicReplace(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.maintenance.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export class Rc2CoreHost implements DshCoreHost {
  readonly ctx: Rc2RuntimeContext;
  readonly observation: Rc2CoreContractObservation;

  constructor(ctx: Rc2RuntimeContext, observation: Rc2CoreContractObservation) {
    this.ctx = ctx;
    this.observation = clone(observation);
  }

  observeContract(): Promise<Rc2CoreContractObservation> {
    return Promise.resolve(clone(this.observation));
  }

  isSessionLive(sessionId: string): boolean {
    return this.ctx.sessions.get(sessionId) !== undefined;
  }

  async captureSession(sessionId: string): Promise<DshSessionArtifactCapture> {
    const header = (await this.ctx.sessionPersistence.list()).find((item) => item.id === sessionId);
    if (header === undefined) return { exists: false };
    const inspected = await this.ctx.sessionPersistence.inspect(sessionId);
    const location = this.ctx.sessionPersistence.locate(inspected.meta);
    const before = await stat(location.path, { bigint: true });
    const artifact = await readFile(location.path);
    const after = await stat(location.path, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new Error(`DSH artifact changed during Core capture: ${sessionId}`);
    }
    return {
      exists: true,
      header: clone(inspected.meta),
      events: clone(inspected.events),
      revision: `${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}`,
      artifact: artifact.toString("base64"),
    };
  }

  async captureWorkspace(sessionId: string, workspaceId?: string): Promise<DshWorkspaceSnapshot> {
    const entity = workspaceId === undefined
      ? this.ctx.workspaceRegistry.list().find((item) => item.sessionIds.includes(sessionId))
      : this.ctx.workspaceRegistry.get(workspaceId);
    const memberIndex = entity?.sessionIds.indexOf(sessionId) ?? -1;
    return {
      workspaceId: entity?.id ?? workspaceId ?? null,
      memberIndex: memberIndex < 0 ? null : memberIndex,
      beforeSessionId: memberIndex < 0 ? null : entity?.sessionIds[memberIndex + 1] ?? null,
      archived: this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId),
    };
  }

  captureProjection(sessionId: string): Promise<DshProjectionSnapshot> {
    const record = this.ctx.sessionProjectionCache.table.get(sessionId);
    return Promise.resolve(
      record === undefined
        ? { present: false }
        : { present: true, record: clone(record) as never },
    );
  }

  async captureRuntime(sessionId: string): Promise<DshRuntimeSnapshot> {
    await this.ctx.sessionQuery._ensureReady();
    const db = this.ctx.sessionQuery._db;
    const rows = db === undefined
      ? []
      : {
          session: db.prepare(`
            SELECT id, version, created_at, cwd, parent_session, seed_length,
                   delegation_depth, agent_preset
              FROM persisted_sessions
             WHERE id = ?
          `).all(sessionId),
          docs: db.prepare(`
            SELECT text, session_id, seq, type, time, surface, codepoint_length
              FROM persisted_docs
             WHERE session_id = ?
             ORDER BY seq, rowid
          `).all(sessionId),
        };
    return {
      coordinator: this.ctx.sessionPersistence.coordinator.states.has(sessionId) ? "cached" : "cold",
      queryIndex: hash(rows),
    };
  }

  createSession(header: DshNativeSessionHeader): Promise<void> {
    return this.ctx.sessionPersistence.create(header);
  }

  appendEvents(sessionId: string, events: readonly DshNativeEvent[]): Promise<void> {
    return this.ctx.sessionPersistence.append(sessionId, events);
  }

  async attachWorkspace(sessionId: string, workspaceId: string): Promise<void> {
    await this.ctx.workspaceRegistry.replaceHeaderIndex(await this.ctx.sessionPersistence.list());
    const workspace = this.ctx.workspaceRegistry.get(workspaceId);
    if (workspace === undefined) throw new Error(`Unknown DSH workspace: ${workspaceId}`);
    await workspace.attachSession(sessionId);
  }

  async setArchive(sessionId: string, archived: boolean): Promise<void> {
    if (archived) {
      await this.ctx.workspaceRegistry.archiveSession(sessionId);
      return;
    }
    await this.ctx.workspaceRegistry.enqueueOperation(async () => {
      const state = this.ctx.workspaceRegistry.state;
      if (!state.archivedSessionIds.includes(sessionId)) return;
      await this.ctx.workspaceRegistry.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
      });
    });
  }

  invalidateProjection(sessionId: string): Promise<void> {
    return this.ctx.sessionProjectionCache.table.delete(sessionId);
  }

  async reconcileRuntime(_sessionId: string): Promise<void> {
    await this.ctx.sessionQuery._serialized(undefined, async () => {
      await this.ctx.sessionQuery._ensureReady();
      await this.ctx.sessionQuery._reconcile();
    });
  }

  async restoreSession(snapshot: DshSessionArtifactSnapshot): Promise<void> {
    const persistence = this.ctx.sessionPersistence;
    await persistence.coordinator.serialize(snapshot.sessionId, async () => {
      if (this.isSessionLive(snapshot.sessionId)) {
        throw new Error(`Cannot restore live DSH session: ${snapshot.sessionId}`);
      }
      const current = (await persistence.list()).find((item) => item.id === snapshot.sessionId);
      const meta = snapshot.exists ? snapshot.header : current;
      if (meta !== undefined) {
        const path = persistence.locate(meta).path;
        if (snapshot.exists) await atomicReplace(path, Buffer.from(snapshot.artifact, "base64"));
        else await unlink(path).catch((error: unknown) => {
          if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        });
      }
      persistence.coordinator.states.delete(snapshot.sessionId);
      persistence.coordinator.preparations.invalidate(snapshot.sessionId);
    });
  }

  async restoreWorkspace(sessionId: string, snapshot: DshWorkspaceSnapshot): Promise<void> {
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      if (workspace.sessionIds.includes(sessionId)) await workspace.detachSession(sessionId);
    }
    if (snapshot.workspaceId !== null && snapshot.memberIndex !== null) {
      await this.ctx.workspaceRegistry.replaceHeaderIndex(await this.ctx.sessionPersistence.list());
      const workspace = this.ctx.workspaceRegistry.get(snapshot.workspaceId);
      if (workspace === undefined) throw new Error(`Unknown DSH workspace: ${snapshot.workspaceId}`);
      await workspace.attachSession(sessionId);
      await workspace.insertSessionBefore(sessionId, snapshot.beforeSessionId ?? undefined);
    }
    await this.setArchive(sessionId, snapshot.archived);
  }

  restoreProjection(sessionId: string, snapshot: DshProjectionSnapshot): Promise<void> {
    return snapshot.present
      ? this.ctx.sessionProjectionCache.table.put(sessionId, clone(snapshot.record))
      : this.ctx.sessionProjectionCache.table.delete(sessionId);
  }
}
