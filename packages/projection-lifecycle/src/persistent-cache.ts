import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type {
  AdapterVerificationResult,
  CanonicalProjectionInput,
  CanonicalProjectionSessionInput,
  DshSessionAdapterV1,
  JsonValue,
  LogicalSessionId,
  NativeSessionId,
  PersistentProjectionCacheManifestV1,
  ProjectionCacheSessionStateV1,
  ProjectionCacheWorkspaceStateV1,
  ProjectionDeltaApplyReceiptV1,
  ProjectionInspection,
  ProjectionManifest,
  ProjectionRun,
  ProjectionWriter,
} from "@linmu/dsh-session-contracts";
import {
  persistentProjectionCacheManifestV1Schema,
  projectionDeltaApplyReceiptV1Schema,
} from "@linmu/dsh-session-contracts";
import type { StatusLog, StatusSpanHandle } from "@linmu/dsh-session-status-log";

import {
  JsonProjectionDirectory,
  type IncrementalCanonicalProjectionSource,
} from "./materialize.js";

const CACHE_MANIFEST_FILE = "projection-cache-manifest.json";
const CHANGE_PAGE_LIMIT = 1_000;

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function digest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex")}`;
}

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function writeJsonAtomically(path: string, value: JsonValue): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.cache-manifest-${randomUUID()}.tmp`);
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

export interface PersistentProjectionCacheIdentity {
  readonly cacheKey: string;
  readonly adapterFingerprint: string;
  readonly configurationDigest: string;
}

export interface PersistentProjectionCacheApplyInput {
  readonly run: ProjectionRun;
  readonly configuration: JsonValue;
}

export interface PersistentProjectionCacheApplyResult {
  readonly cacheRoot: string;
  readonly cacheManifest: PersistentProjectionCacheManifestV1;
  readonly projectionManifest: ProjectionManifest;
  readonly inspection: ProjectionInspection;
  readonly verification: AdapterVerificationResult;
  readonly receipt: ProjectionDeltaApplyReceiptV1;
}

export function projectionCacheIdentity(
  adapter: DshSessionAdapterV1,
  configuration: JsonValue,
): PersistentProjectionCacheIdentity {
  const configurationDigest = digest(configuration);
  const adapterFingerprint = digest(adapter.manifest as unknown as JsonValue);
  return {
    cacheKey: digest({ adapterId: adapter.manifest.id, configurationDigest }),
    adapterFingerprint,
    configurationDigest,
  };
}

export function projectionCacheRootFor(
  runtimeRoot: string,
  adapterId: string,
  configurationDigest: string,
): string {
  return join(resolve(runtimeRoot), "caches", encoded(adapterId), encoded(configurationDigest), "projection");
}

class CacheProjectionWriter implements ProjectionWriter {
  readonly sessionDigests = new Map<string, string>();
  readonly workspaceDigests = new Map<string, string>();
  readonly rewrittenSessionIds = new Set<string>();
  readonly rewrittenWorkspaceIds = new Set<string>();
  readonly seenWorkspaceIds = new Set<string>();

  constructor(
    private readonly directory: JsonProjectionDirectory,
    private readonly baseline: boolean,
    sessions: readonly ProjectionCacheSessionStateV1[],
    workspaces: readonly ProjectionCacheWorkspaceStateV1[],
  ) {
    for (const session of sessions) this.sessionDigests.set(session.nativeSessionId, session.nativeDigest);
    for (const workspace of workspaces) this.workspaceDigests.set(workspace.nativeWorkspaceId, workspace.nativeDigest);
  }

  async writeWorkspace(nativeWorkspaceId: string, payload: JsonValue): Promise<void> {
    const nextDigest = digest(payload);
    this.seenWorkspaceIds.add(nativeWorkspaceId);
    if (this.workspaceDigests.get(nativeWorkspaceId) === nextDigest) return;
    if (this.baseline) await this.directory.writeWorkspace(nativeWorkspaceId, payload);
    else await this.directory.replaceWorkspace(nativeWorkspaceId, payload);
    this.workspaceDigests.set(nativeWorkspaceId, nextDigest);
    this.rewrittenWorkspaceIds.add(nativeWorkspaceId);
  }

  async writeSession(nativeSessionId: NativeSessionId, payload: JsonValue): Promise<void> {
    const nextDigest = digest(payload);
    if (this.sessionDigests.get(nativeSessionId) === nextDigest) return;
    if (this.baseline) await this.directory.writeSession(nativeSessionId, payload);
    else await this.directory.replaceSession(nativeSessionId, payload);
    this.sessionDigests.set(nativeSessionId, nextDigest);
    this.rewrittenSessionIds.add(nativeSessionId);
  }
}

function inspectionFromManifest(manifest: ProjectionManifest): ProjectionInspection {
  return {
    sessionCount: manifest.sessionCount,
    workspaceCount: manifest.workspaceCount,
    catalogDigest: manifest.catalogDigest,
    sessionDigests: manifest.sessionDigests,
    issues: [],
  };
}

function cacheDiagnostic(receipt: ProjectionDeltaApplyReceiptV1): string {
  return [
    "diag:projection-delta",
    receipt.fromRevision,
    receipt.throughRevision,
    receipt.changedSessions,
    receipt.rewrittenSessions,
    receipt.removedSessions,
    receipt.unchangedSessions,
  ].join(":");
}

function projectedNativeRevision(
  adapter: DshSessionAdapterV1,
  canonical: CanonicalProjectionSessionInput,
  payload: JsonValue,
): number {
  const revision = adapter.projectedNativeRevision?.(canonical, payload) ?? canonical.events.length;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError(`Adapter returned an invalid native revision for ${canonical.session.id}`);
  }
  return revision;
}

export class PersistentProjectionCache {
  private readonly runtimeRoot: string;
  private readonly source: IncrementalCanonicalProjectionSource;
  private readonly adapter: DshSessionAdapterV1;
  private readonly statusLog: StatusLog;
  private readonly clock: () => string;

  constructor(input: {
    readonly runtimeRoot: string;
    readonly source: IncrementalCanonicalProjectionSource;
    readonly adapter: DshSessionAdapterV1;
    readonly statusLog: StatusLog;
    readonly clock?: () => string;
  }) {
    this.runtimeRoot = resolve(input.runtimeRoot);
    this.source = input.source;
    this.adapter = input.adapter;
    this.statusLog = input.statusLog;
    this.clock = input.clock ?? (() => new Date().toISOString());
  }

  async apply(input: PersistentProjectionCacheApplyInput): Promise<PersistentProjectionCacheApplyResult> {
    if (input.run.adapterId !== this.adapter.manifest.id) {
      throw new TypeError(`Projection run Adapter mismatch: ${input.run.adapterId}/${this.adapter.manifest.id}`);
    }
    const identity = projectionCacheIdentity(this.adapter, input.configuration);
    const cacheRoot = projectionCacheRootFor(this.runtimeRoot, this.adapter.manifest.id, identity.configurationDigest);
    const span = await this.startSpan(input.run);
    try {
      const existing = await this.readCacheManifest(cacheRoot);
      const currentRevision = await this.source.currentRevision();
      const result = existing === undefined
        || existing.cacheKey !== identity.cacheKey
        || existing.adapterId !== this.adapter.manifest.id
        || existing.adapterFingerprint !== identity.adapterFingerprint
        || existing.configurationDigest !== identity.configurationDigest
        || existing.lastAppliedRevision > currentRevision
        ? await this.rebuildBaseline(input.run, cacheRoot, identity)
        : await this.applyDelta(input.run, cacheRoot, identity, existing, currentRevision);
      await this.statusLog.succeed(span, { diagnosticDetailRef: cacheDiagnostic(result.receipt) });
      return result;
    } catch (error) {
      await this.statusLog.fail(span, {
        errorCode: "PROJECTION_DELTA_APPLY_FAILED",
        diagnosticDetailRef: "diag:projection-delta:failed",
      });
      throw error;
    }
  }

  private async rebuildBaseline(
    run: ProjectionRun,
    cacheRoot: string,
    identity: PersistentProjectionCacheIdentity,
  ): Promise<PersistentProjectionCacheApplyResult> {
    let projectionInput: CanonicalProjectionInput | undefined;
    let revision = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await this.source.currentRevision();
      const loaded = await this.source.load(run);
      const after = await this.source.currentRevision();
      if (before === after) {
        projectionInput = loaded;
        revision = after;
        break;
      }
    }
    if (projectionInput === undefined) {
      throw new Error("Canonical source changed repeatedly while building the projection baseline");
    }

    const parent = dirname(cacheRoot);
    const stagingRoot = join(parent, `.build-${randomUUID()}`);
    const backupRoot = join(parent, `.previous-${randomUUID()}`);
    await mkdir(parent, { recursive: true });
    const directory = new JsonProjectionDirectory(stagingRoot);
    await directory.initialize();
    const writer = new CacheProjectionWriter(directory, true, [], []);
    try {
      const nativeIds = new Map(await Promise.all(projectionInput.sessions.map(async (item) => [
        item.session.id,
        await this.nativeSessionId(item, run),
      ] as const)));
      const projectionManifest = await this.adapter.materialize(projectionInput, writer);
      await directory.writeManifest(projectionManifest);
      await directory.rebuildSessionCatalog(run.id, new Map(projectionInput.sessions.map((item) => [
        nativeIds.get(item.session.id)!,
        item.session.updatedAt,
      ])));
      const inspection = await this.adapter.inspect(directory);
      const verification = await this.adapter.verify(projectionManifest, inspection);
      if (!verification.ok) throw new Error("Projection cache baseline verification failed");
      const now = this.clock();
      const cacheManifest = persistentProjectionCacheManifestV1Schema.parse({
        schemaVersion: 1,
        cacheKey: identity.cacheKey,
        adapterId: this.adapter.manifest.id,
        adapterFingerprint: identity.adapterFingerprint,
        configurationDigest: identity.configurationDigest,
        lastAppliedRevision: revision,
        sessions: await Promise.all(projectionInput.sessions.map(async (item) => {
          const nativeSessionId = nativeIds.get(item.session.id)!;
          const nativeDigest = projectionManifest.sessionDigests[nativeSessionId];
          if (nativeDigest === undefined) throw new Error(`Projection manifest omitted ${nativeSessionId}`);
          return {
            schemaVersion: 1,
            logicalSessionId: item.session.id,
            nativeSessionId,
            canonicalHeadVersionId: item.session.headVersionId,
            canonicalUpdatedAt: item.session.updatedAt,
            title: item.session.title,
            tags: item.session.tags,
            archivedAt: item.session.archivedAt,
            workspaceId: item.workspaceId,
            projectId: item.projectId ?? null,
            authorityScope: item.session.authorityScope,
            nativeRevision: projectedNativeRevision(
              this.adapter,
              item,
              await directory.readSession(nativeSessionId),
            ),
            nativeDigest,
          };
        })).then((sessions) => sessions.sort((left, right) => left.logicalSessionId.localeCompare(right.logicalSessionId))),
        workspaces: [...writer.workspaceDigests.entries()].map(([nativeWorkspaceId, nativeDigest]) => ({
          schemaVersion: 1,
          nativeWorkspaceId,
          nativeDigest,
        })).sort((left, right) => left.nativeWorkspaceId.localeCompare(right.nativeWorkspaceId)),
        createdAt: now,
        updatedAt: now,
      }) as unknown as PersistentProjectionCacheManifestV1;
      await writeJsonAtomically(join(stagingRoot, CACHE_MANIFEST_FILE), cacheManifest as unknown as JsonValue);
      const hadPrevious = await exists(cacheRoot);
      if (hadPrevious) await rename(cacheRoot, backupRoot);
      try {
        await rename(stagingRoot, cacheRoot);
      } catch (error) {
        if (hadPrevious) await rename(backupRoot, cacheRoot).catch(() => undefined);
        throw error;
      }
      if (hadPrevious) await rm(backupRoot, { recursive: true, force: true });
      const receipt = projectionDeltaApplyReceiptV1Schema.parse({
        schemaVersion: 1,
        cacheKey: identity.cacheKey,
        baseline: true,
        fromRevision: 0,
        throughRevision: revision,
        currentRevision: revision,
        changedSessions: projectionInput.sessions.length,
        rewrittenSessions: projectionInput.sessions.length,
        removedSessions: 0,
        unchangedSessions: 0,
        rewrittenWorkspaces: writer.rewrittenWorkspaceIds.size,
        removedWorkspaces: 0,
      }) as ProjectionDeltaApplyReceiptV1;
      return { cacheRoot, cacheManifest, projectionManifest, inspection, verification, receipt };
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async applyDelta(
    run: ProjectionRun,
    cacheRoot: string,
    identity: PersistentProjectionCacheIdentity,
    current: PersistentProjectionCacheManifestV1,
    observedCurrentRevision: number,
  ): Promise<PersistentProjectionCacheApplyResult> {
    const changes = [] as Array<{ readonly logicalSessionId: LogicalSessionId }>;
    let cursor = current.lastAppliedRevision;
    let currentRevision = observedCurrentRevision;
    while (cursor < currentRevision) {
      const page = await this.source.listChanges({ afterRevision: cursor, limit: CHANGE_PAGE_LIMIT });
      if (page.throughRevision <= cursor) {
        throw new Error(`Canonical change journal did not advance beyond revision ${cursor}`);
      }
      changes.push(...page.changes);
      cursor = page.throughRevision;
      currentRevision = page.currentRevision;
    }
    const affectedIds = [...new Set(changes.map((change) => change.logicalSessionId))];
    if (affectedIds.length === 0) {
      const projectionManifest = this.composeManifest(run, current);
      const inspection = inspectionFromManifest(projectionManifest);
      const verification = await this.adapter.verify(projectionManifest, inspection);
      if (!verification.ok) throw new Error("Unchanged projection cache manifest verification failed");
      const receipt = projectionDeltaApplyReceiptV1Schema.parse({
        schemaVersion: 1,
        cacheKey: identity.cacheKey,
        baseline: false,
        fromRevision: current.lastAppliedRevision,
        throughRevision: current.lastAppliedRevision,
        currentRevision: current.lastAppliedRevision,
        changedSessions: 0,
        rewrittenSessions: 0,
        removedSessions: 0,
        unchangedSessions: current.sessions.length,
        rewrittenWorkspaces: 0,
        removedWorkspaces: 0,
      }) as ProjectionDeltaApplyReceiptV1;
      return { cacheRoot, cacheManifest: current, projectionManifest, inspection, verification, receipt };
    }

    const directory = new JsonProjectionDirectory(cacheRoot);
    await directory.initialize();
    const selected = await this.source.loadSessions(run, affectedIds);
    const currentByLogical = new Map(current.sessions.map((session) => [session.logicalSessionId, session]));
    const selectedByLogical = new Map(selected.sessions.map((session) => [session.session.id, session]));
    let removedSessions = 0;
    for (const logicalSessionId of affectedIds) {
      if (selectedByLogical.has(logicalSessionId)) continue;
      const old = currentByLogical.get(logicalSessionId);
      if (old !== undefined) {
        if (await directory.removeSession(old.nativeSessionId)) removedSessions += 1;
        currentByLogical.delete(logicalSessionId);
      }
    }

    const writer = new CacheProjectionWriter(directory, false, [...currentByLogical.values()], current.workspaces);
    const partialManifest = await this.adapter.materialize(selected, writer);
    for (const item of selected.sessions) {
      const nativeSessionId = await this.nativeSessionId(item, run);
      const old = currentByLogical.get(item.session.id);
      if (old !== undefined && old.nativeSessionId !== nativeSessionId) {
        if (await directory.removeSession(old.nativeSessionId)) removedSessions += 1;
      }
      const nativeDigest = partialManifest.sessionDigests[nativeSessionId];
      if (nativeDigest === undefined) throw new Error(`Projection delta manifest omitted ${nativeSessionId}`);
      currentByLogical.set(item.session.id, {
        schemaVersion: 1,
        logicalSessionId: item.session.id,
        nativeSessionId,
        canonicalHeadVersionId: item.session.headVersionId,
        canonicalUpdatedAt: item.session.updatedAt,
        title: item.session.title,
        tags: item.session.tags,
        archivedAt: item.session.archivedAt,
        workspaceId: item.workspaceId,
        projectId: item.projectId ?? null,
        authorityScope: item.session.authorityScope,
        nativeRevision: projectedNativeRevision(
          this.adapter,
          item,
          await directory.readSession(nativeSessionId),
        ),
        nativeDigest,
      });
    }

    let removedWorkspaces = 0;
    const nextWorkspaceIds = writer.seenWorkspaceIds;
    for (const workspace of current.workspaces) {
      if (nextWorkspaceIds.has(workspace.nativeWorkspaceId)) continue;
      if (await directory.removeWorkspace(workspace.nativeWorkspaceId)) removedWorkspaces += 1;
      writer.workspaceDigests.delete(workspace.nativeWorkspaceId);
    }
    const sessions = [...currentByLogical.values()].sort((left, right) => left.logicalSessionId.localeCompare(right.logicalSessionId));
    const workspaces = [...writer.workspaceDigests.entries()].map(([nativeWorkspaceId, nativeDigest]) => ({
      schemaVersion: 1 as const,
      nativeWorkspaceId,
      nativeDigest,
    })).sort((left, right) => left.nativeWorkspaceId.localeCompare(right.nativeWorkspaceId));
    const cacheManifest = persistentProjectionCacheManifestV1Schema.parse({
      ...current,
      lastAppliedRevision: cursor,
      sessions,
      workspaces,
      updatedAt: this.clock(),
    }) as unknown as PersistentProjectionCacheManifestV1;
    const projectionManifest = this.composeManifest(run, cacheManifest);
    await directory.replaceManifest(projectionManifest);
    await directory.rebindSessionCatalog(run.id);
    const inspection = inspectionFromManifest(projectionManifest);
    const verification = await this.adapter.verify(projectionManifest, inspection);
    if (!verification.ok) throw new Error("Projection cache delta verification failed");
    await writeJsonAtomically(join(cacheRoot, CACHE_MANIFEST_FILE), cacheManifest as unknown as JsonValue);
    const receipt = projectionDeltaApplyReceiptV1Schema.parse({
      schemaVersion: 1,
      cacheKey: identity.cacheKey,
      baseline: false,
      fromRevision: current.lastAppliedRevision,
      throughRevision: cursor,
      currentRevision,
      changedSessions: affectedIds.length,
      rewrittenSessions: writer.rewrittenSessionIds.size,
      removedSessions,
      unchangedSessions: Math.max(0, sessions.length - writer.rewrittenSessionIds.size),
      rewrittenWorkspaces: writer.rewrittenWorkspaceIds.size,
      removedWorkspaces,
    }) as ProjectionDeltaApplyReceiptV1;
    return { cacheRoot, cacheManifest, projectionManifest, inspection, verification, receipt };
  }

  private composeManifest(
    run: ProjectionRun,
    cacheManifest: PersistentProjectionCacheManifestV1,
  ): ProjectionManifest {
    if (this.adapter.composeProjectionManifest === undefined) {
      throw new TypeError(`Adapter does not support persistent projection manifests: ${this.adapter.manifest.id}`);
    }
    return this.adapter.composeProjectionManifest({
      run,
      sessionDigests: Object.fromEntries(cacheManifest.sessions.map((session) => [session.nativeSessionId, session.nativeDigest])),
      workspaceIds: cacheManifest.workspaces.map((workspace) => workspace.nativeWorkspaceId),
    });
  }

  private async nativeSessionId(
    item: CanonicalProjectionSessionInput,
    run: ProjectionRun,
  ): Promise<NativeSessionId> {
    const reference = await this.adapter.resolveReference({
      logicalSessionId: item.session.id,
      logicalAnchorId: null,
      legacyNativeSessionId: null,
    }, run);
    if (reference.nativeSessionId === null || reference.status !== "resolved") {
      throw new TypeError(`Adapter did not resolve native identity for ${item.session.id}`);
    }
    return reference.nativeSessionId;
  }

  private startSpan(run: ProjectionRun): Promise<StatusSpanHandle> {
    return this.statusLog.start({
      runId: run.id,
      leaseId: run.leaseId,
      profileId: run.profileId,
      adapterId: run.adapterId,
      dshVersion: run.dshVersion,
      stage: "projection.delta-apply",
      logicalSessionId: null,
      nativeSessionId: null,
      operationId: null,
      diagnosticDetailRef: "diag:projection-delta:started",
    });
  }

  async readCacheManifest(cacheRoot: string): Promise<PersistentProjectionCacheManifestV1 | undefined> {
    try {
      return persistentProjectionCacheManifestV1Schema.parse(
        JSON.parse(await readFile(join(cacheRoot, CACHE_MANIFEST_FILE), "utf8")),
      ) as unknown as PersistentProjectionCacheManifestV1;
    } catch (error) {
      if (isMissing(error)) return undefined;
      if (error instanceof SyntaxError || (typeof error === "object" && error !== null && "issues" in error)) return undefined;
      throw error;
    }
  }
}
