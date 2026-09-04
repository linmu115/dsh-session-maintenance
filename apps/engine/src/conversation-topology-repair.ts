import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { open, readFile, rename } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import {
  inspectRc1,
  materializeRc1,
  portableizeRc1CanonicalHistory,
  verifyRc1,
} from "@linmu/dsh-session-adapter-rc1";
import {
  buildCanonicalVersion,
  CanonicalSessionEngine,
} from "@linmu/dsh-canonical-session-engine";
import type {
  CanonicalEventV1,
  Checkpoint,
  CheckpointId,
  JsonValue,
  LogicalSessionId,
  NativeSessionId,
  OperationId,
  ProjectionReader,
  ProjectionRun,
  ProjectionWriter,
  RegisteredInstance,
  SessionVersionId,
} from "@linmu/dsh-session-contracts";
import {
  canonicalJson,
  sha256Canonical,
  withPlannedConversationTopology,
} from "@linmu/dsh-session-domain";
import { SqliteCanonicalProjectionSource } from "@linmu/dsh-session-projection-lifecycle";
import {
  openMaintenanceDatabase,
  SqliteAdapterEvidenceStore,
  SqliteCanonicalRepository,
  SqliteCanonicalSessionEngineStore,
  SqliteSessionRepository,
  ZstdContentObjectStore,
} from "@linmu/dsh-session-store";

import {
  applyCodexCanonicalImportPlan,
  visitCodexCanonicalImportPlan,
  type CanonicalImportPlanSummaryV1,
  type CodexCanonicalImportResult,
} from "./codex-canonical-import.js";
import { SqliteCodexProjectPort } from "./sqlite-codex-project-port.js";

export type ConversationTopologyRepairStage =
  | "repair.preview"
  | "repair.checkpoint"
  | "repair.codex-plan"
  | "repair.mirror-write"
  | "repair.derived-recompose"
  | "repair.rc1-verify"
  | "repair.candidate-ready";

export interface ConversationTopologyRepairStatus {
  readonly stage: ConversationTopologyRepairStage;
  readonly state: "started" | "succeeded" | "failed";
  readonly detail: string;
}

export interface ConversationTopologyRepairPreviewV1 {
  readonly schemaVersion: 1;
  readonly sourceDatabasePath: string;
  readonly candidateDatabasePath: string;
  readonly sourceDigest: string;
  readonly codexPlanDigest: string;
  readonly currentRevision: number;
  readonly scannedCodexSessions: number;
  readonly plannedCodexMirrors: number;
  readonly retriedCodexSessions: number;
  readonly existingCodexMirrors: number;
  readonly retiredCodexMirrors: number;
  readonly derivedSessionsToRecompose: number;
  readonly derivedSessionsWithRetiredParent: number;
  readonly candidateExists: false;
}

export interface ConversationTopologyRepairManifestV1 {
  readonly schemaVersion: 1;
  readonly migrationKind: "mcsf-conversation-topology-rc1";
  readonly createdAt: string;
  readonly sourceDatabasePath: string;
  readonly sourceDigest: string;
  readonly codexPlanDigest: string;
  readonly candidateDatabasePath: string;
  readonly candidateDigest: string;
  readonly checkpointId: string;
  readonly codexImport: CodexCanonicalImportResult;
  readonly retiredCodexMirrors: number;
  readonly recomposedDerivedSessions: number;
  readonly verifiedRc1Sessions: number;
  readonly integrityCheck: "ok";
  readonly foreignKeyViolations: 0;
}

export interface ConversationTopologyRepairInput {
  readonly stateRoot: string;
  readonly sourceDatabasePath: string;
  readonly candidateFile: string;
  readonly codexInstance: RegisteredInstance;
  readonly fixtureGuard?: (root: string) => void;
  readonly now?: () => string;
  readonly onStatus?: (status: ConversationTopologyRepairStatus) => void | Promise<void>;
}

export interface StageConversationTopologyRepairInput extends ConversationTopologyRepairInput {
  readonly expectedSourceDigest: string;
  readonly expectedCodexPlanDigest: string;
}

interface DerivationRow {
  readonly child_session_id: string;
  readonly parent_session_id: string;
  readonly base_version_id: string;
}

interface SessionHeadRow {
  readonly id: string;
  readonly head_version_id: string | null;
}

interface ActiveRunRow {
  readonly id: string;
  readonly state: string;
}

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function resolveSourcePath(stateRoot: string, sourceDatabasePath: string): string {
  const root = resolve(stateRoot);
  const source = resolve(sourceDatabasePath);
  if (!contained(root, source)) throw new Error("Maintenance source database escapes the selected state root");
  return source;
}

function resolveCandidatePath(stateRoot: string, candidateFile: string): string {
  if (!/^metadata(?:\.[a-z0-9-]+)?\.sqlite$/u.test(candidateFile) || basename(candidateFile) !== candidateFile) {
    throw new TypeError(`Invalid candidate database filename: ${candidateFile}`);
  }
  const root = resolve(stateRoot);
  const candidate = resolve(root, candidateFile);
  if (!contained(root, candidate)) throw new Error("Maintenance candidate database escapes the selected state root");
  return candidate;
}

function openReadOnlyDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function activeRuns(database: DatabaseSync): readonly ActiveRunRow[] {
  return database.prepare(
    `SELECT id, state FROM projection_runs
     WHERE state IN ('preparing', 'running', 'draining', 'verifying')
     ORDER BY id`,
  ).all() as unknown as ActiveRunRow[];
}

function assertNoActiveProjectionRun(database: DatabaseSync): void {
  const rows = activeRuns(database);
  if (rows.length > 0) {
    throw new Error(`Conversation repair requires every projection run to be closed: ${rows.map((row) => `${row.id}:${row.state}`).join(", ")}`);
  }
}

function rows(database: DatabaseSync, sql: string): readonly JsonValue[] {
  return database.prepare(sql).all() as unknown as JsonValue[];
}

function sourceState(database: DatabaseSync): {
  readonly digest: string;
  readonly currentRevision: number;
} {
  const revision = database.prepare(
    "SELECT COALESCE(MAX(revision), 0) AS revision FROM canonical_change_log",
  ).get() as { readonly revision: number };
  const snapshot = {
    schemaVersion: database.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
    ).get(),
    currentRevision: revision.revision,
    sessions: rows(database,
      `SELECT id, authority_scope, origin_kind, head_version_id, display_title,
              archived_at, tombstoned_at, updated_at
       FROM logical_sessions ORDER BY id`),
    derivations: rows(database,
      `SELECT child_session_id, parent_session_id, base_version_id,
              derivation_kind, trigger_operation_id
       FROM session_derivations ORDER BY child_session_id`),
    workspaces: rows(database,
      `SELECT logical_session_id, workspace_id, revision
       FROM workspace_memberships ORDER BY logical_session_id`),
    projects: rows(database,
      `SELECT logical_session_id, project_id, revision
       FROM project_memberships ORDER BY logical_session_id`),
    tombstones: rows(database,
      `SELECT logical_session_id, operation_id, checkpoint_id, restored_at
       FROM session_tombstones ORDER BY logical_session_id`),
  } as unknown as JsonValue;
  return { digest: sha256Canonical(snapshot), currentRevision: revision.revision };
}

function planDigest(plan: CanonicalImportPlanSummaryV1): string {
  return sha256Canonical({
    schemaVersion: 1,
    instanceId: plan.instanceId,
    scanned: plan.scanned,
    retried: plan.retried,
    sessions: plan.sessions.map((item) => ({
      logicalSessionId: item.logicalSessionId,
      sourceSessionId: item.sourceSessionId,
      sourceCursor: item.sourceCursor,
      project: item.assignment.project,
      workspaceId: item.assignment.workspaceId,
      normalizedDigest: item.normalizedDigest,
    })),
  } as unknown as JsonValue);
}

function mirrorIds(database: DatabaseSync): readonly string[] {
  return (database.prepare(
    `SELECT id FROM logical_sessions
     WHERE authority_scope = 'codex' AND origin_kind = 'codex-mirror'
     ORDER BY id`,
  ).all() as unknown as Array<{ readonly id: string }>).map((row) => row.id);
}

function derivations(database: DatabaseSync): readonly DerivationRow[] {
  return database.prepare(
    `SELECT child_session_id, parent_session_id, base_version_id
     FROM session_derivations ORDER BY child_session_id`,
  ).all() as unknown as DerivationRow[];
}

async function status(
  callback: ConversationTopologyRepairInput["onStatus"],
  stage: ConversationTopologyRepairStage,
  state: ConversationTopologyRepairStatus["state"],
  detail: string,
): Promise<void> {
  await callback?.({ stage, state, detail });
}

async function buildStablePlan(input: ConversationTopologyRepairInput): Promise<{
  readonly source: ReturnType<typeof sourceState>;
  readonly plan: CanonicalImportPlanSummaryV1;
  readonly digest: string;
}> {
  const source = resolveSourcePath(input.stateRoot, input.sourceDatabasePath);
  const database = openReadOnlyDatabase(source);
  try {
    assertNoActiveProjectionRun(database);
    const before = sourceState(database);
    await status(input.onStatus, "repair.codex-plan", "started", `reading ${input.codexInstance.id} without write capability`);
    try {
      const plan = await visitCodexCanonicalImportPlan({
        instance: input.codexInstance,
        ...(input.fixtureGuard === undefined ? {} : { fixtureGuard: input.fixtureGuard }),
        visitSession: () => undefined,
      });
      const after = sourceState(database);
      if (after.digest !== before.digest) {
        throw new Error("Maintenance source changed while the Codex repair plan was being prepared");
      }
      if (plan.retried > 0) {
        throw new Error(`Codex repair plan has ${plan.retried} unstable reads; retry preview after the source settles`);
      }
      const digest = planDigest(plan);
      await status(input.onStatus, "repair.codex-plan", "succeeded", `planned=${plan.sessions.length}; digest=${digest}`);
      return { source: before, plan, digest };
    } catch (error) {
      await status(input.onStatus, "repair.codex-plan", "failed", error instanceof Error ? error.message : "unknown failure");
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function previewConversationTopologyRepair(
  input: ConversationTopologyRepairInput,
): Promise<ConversationTopologyRepairPreviewV1> {
  await status(input.onStatus, "repair.preview", "started", "validating immutable source and empty candidate target");
  try {
    const source = resolveSourcePath(input.stateRoot, input.sourceDatabasePath);
    const candidate = resolveCandidatePath(input.stateRoot, input.candidateFile);
    if (existsSync(candidate)) throw new Error(`Conversation repair candidate already exists: ${candidate}`);
    const planned = await buildStablePlan(input);
    const database = openReadOnlyDatabase(source);
    try {
      assertNoActiveProjectionRun(database);
      const existing = mirrorIds(database);
      const selected = new Set(planned.plan.sessions.map((item) => String(item.logicalSessionId)));
      const derived = derivations(database);
      const result: ConversationTopologyRepairPreviewV1 = {
        schemaVersion: 1,
        sourceDatabasePath: source,
        candidateDatabasePath: candidate,
        sourceDigest: planned.source.digest,
        codexPlanDigest: planned.digest,
        currentRevision: planned.source.currentRevision,
        scannedCodexSessions: planned.plan.scanned,
        plannedCodexMirrors: planned.plan.sessions.length,
        retriedCodexSessions: planned.plan.retried,
        existingCodexMirrors: existing.length,
        retiredCodexMirrors: existing.filter((id) => !selected.has(id)).length,
        derivedSessionsToRecompose: derived.filter((row) => selected.has(row.parent_session_id)).length,
        derivedSessionsWithRetiredParent: derived.filter((row) => !selected.has(row.parent_session_id)).length,
        candidateExists: false,
      };
      await status(input.onStatus, "repair.preview", "succeeded", canonicalJson(result as unknown as JsonValue));
      return result;
    } finally {
      database.close();
    }
  } catch (error) {
    await status(input.onStatus, "repair.preview", "failed", error instanceof Error ? error.message : "unknown failure");
    throw error;
  }
}

function checkpointRefs(database: DatabaseSync): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const sessionHeads = database.prepare(
    "SELECT id, head_version_id FROM logical_sessions WHERE head_version_id IS NOT NULL ORDER BY id",
  ).all() as unknown as SessionHeadRow[];
  for (const row of sessionHeads) result[`session:${row.id}`] = row.head_version_id!;
  return result;
}

function sameFrozenPrefix(
  base: readonly CanonicalEventV1[],
  child: readonly CanonicalEventV1[],
): boolean {
  if (child.length < base.length) return false;
  return base.every((event, index) => {
    const candidate = child[index];
    return candidate?.id === event.id && candidate.contentDigest === event.contentDigest;
  });
}

function resequence(events: readonly CanonicalEventV1[]): readonly CanonicalEventV1[] {
  return events.map((event, sequence) => ({ ...event, sequence }));
}

async function recomposeDerivedSessions(input: {
  readonly database: DatabaseSync;
  readonly store: SqliteCanonicalSessionEngineStore;
  readonly rows: readonly DerivationRow[];
  readonly refreshedParents: ReadonlySet<string>;
  readonly at: string;
}): Promise<readonly LogicalSessionId[]> {
  const recomposed: LogicalSessionId[] = [];
  for (const row of input.rows) {
    if (!input.refreshedParents.has(row.parent_session_id)) continue;
    const childId = row.child_session_id as LogicalSessionId;
    const parentId = row.parent_session_id as LogicalSessionId;
    const child = await input.store.getSession(childId);
    const parent = await input.store.getSession(parentId);
    const oldBase = await input.store.getVersion(row.base_version_id as SessionVersionId);
    if (child?.headVersionId === null || child === undefined || parent?.headVersionId === null || parent === undefined || oldBase === undefined) {
      throw new Error(`Derived conversation cannot be recomposed because its lineage is incomplete: ${row.child_session_id}`);
    }
    const oldChildHead = await input.store.getVersion(child.headVersionId);
    const newParentHead = await input.store.getVersion(parent.headVersionId);
    if (oldChildHead === undefined || newParentHead === undefined) {
      throw new Error(`Derived conversation head is missing: ${row.child_session_id}`);
    }
    if (!sameFrozenPrefix(oldBase.events, oldChildHead.events)) {
      throw new Error(`Derived conversation no longer begins at its immutable Codex base: ${row.child_session_id}`);
    }
    const nativeSuffix = oldChildHead.events.slice(oldBase.events.length);
    const portableSuffix = portableizeRc1CanonicalHistory(nativeSuffix);
    const planned = withPlannedConversationTopology(resequence([
      ...newParentHead.events,
      ...portableSuffix,
    ]));
    const version = buildCanonicalVersion({
      logicalSessionId: childId,
      parentVersionIds: [oldChildHead.id, newParentHead.id],
      events: planned.events,
      workspaceId: child.workspaceId,
      title: child.session.title,
      tags: child.session.tags,
      archivedAt: child.session.archivedAt,
      createdAt: input.at,
      allowForeignEventSessionIds: true,
    });
    await input.store.commit({
      kind: "dsh-append",
      operationId: null,
      session: { ...child.session, headVersionId: version.id, updatedAt: input.at },
      version,
      membership: null,
      derivation: null,
      projectionReceipt: null,
      tombstone: null,
      observation: null,
      receipt: {
        outcome: "advanced",
        operationId: null,
        logicalSessionId: childId,
        versionId: version.id,
        tombstoneState: null,
        committedAt: input.at,
      },
    });
    recomposed.push(childId);
  }
  return recomposed;
}

class MemoryRc1Projection implements ProjectionWriter, ProjectionReader {
  readonly sessions = new Map<string, JsonValue>();
  readonly workspaces = new Set<string>();

  async writeWorkspace(nativeWorkspaceId: string, _payload: JsonValue): Promise<void> {
    this.workspaces.add(nativeWorkspaceId);
  }

  async writeSession(nativeSessionId: NativeSessionId, payload: JsonValue): Promise<void> {
    this.sessions.set(nativeSessionId, payload);
  }

  async listNativeSessionIds(): Promise<readonly NativeSessionId[]> {
    return [...this.sessions.keys()] as NativeSessionId[];
  }

  async listNativeWorkspaceIds(): Promise<readonly string[]> {
    return [...this.workspaces];
  }

  async readSession(nativeSessionId: NativeSessionId): Promise<JsonValue> {
    const value = this.sessions.get(nativeSessionId);
    if (value === undefined) throw new Error(`Staged RC1 session is missing: ${nativeSessionId}`);
    return value;
  }
}

async function verifyRc1Sessions(input: {
  readonly database: DatabaseSync;
  readonly objectStore: ZstdContentObjectStore;
  readonly logicalSessionIds: readonly LogicalSessionId[];
  readonly at: string;
}): Promise<number> {
  const source = new SqliteCanonicalProjectionSource(input.database, input.objectStore);
  const run: ProjectionRun = {
    schemaVersion: 1,
    id: "run-m06-rc1-verification" as never,
    leaseId: "lease-m06-rc1-verification" as never,
    branchId: "branch-m06-rc1-verification" as never,
    instanceId: "dsh-rc1-verification",
    profileId: "repair-candidate",
    dshVersion: "0.1.2-rc.1",
    adapterId: "dsh-rc1" as never,
    state: "preparing",
    startedAt: input.at,
    heartbeatAt: input.at,
    checkpointId: null,
  };
  for (const logicalSessionId of input.logicalSessionIds) {
    const canonical = await source.loadSessions(run, [logicalSessionId]);
    if (canonical.sessions.length !== 1) {
      throw new Error(`Candidate RC1 validation could not load ${logicalSessionId}`);
    }
    const staged = new MemoryRc1Projection();
    const manifest = await materializeRc1(canonical, staged);
    const inspection = await inspectRc1(staged);
    const verified = verifyRc1(manifest, inspection);
    if (!verified.ok) {
      throw new Error(`Candidate RC1 validation failed for ${logicalSessionId}: ${canonicalJson(verified.issues as unknown as JsonValue)}`);
    }
  }
  return input.logicalSessionIds.length;
}

function verifyDatabase(database: DatabaseSync): void {
  const integrity = database.prepare("PRAGMA integrity_check").all() as unknown as Array<{ readonly integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error(`Candidate integrity check failed: ${JSON.stringify(integrity)}`);
  }
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length !== 0) {
    throw new Error(`Candidate foreign-key check failed: ${JSON.stringify(foreignKeys)}`);
  }
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function manifestPath(candidatePath: string): string {
  return `${candidatePath}.conversation-repair.json`;
}

async function writeManifest(path: string, manifest: ConversationTopologyRepairManifestV1): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${canonicalJson(manifest as unknown as JsonValue)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function stageConversationTopologyRepair(
  input: StageConversationTopologyRepairInput,
): Promise<ConversationTopologyRepairManifestV1> {
  const sourcePath = resolveSourcePath(input.stateRoot, input.sourceDatabasePath);
  const candidatePath = resolveCandidatePath(input.stateRoot, input.candidateFile);
  if (existsSync(candidatePath)) throw new Error(`Conversation repair candidate already exists: ${candidatePath}`);
  const planned = await buildStablePlan(input);
  if (planned.source.digest !== input.expectedSourceDigest) {
    throw new Error(`Maintenance source digest changed: expected ${input.expectedSourceDigest}, got ${planned.source.digest}`);
  }
  if (planned.digest !== input.expectedCodexPlanDigest) {
    throw new Error(`Codex repair plan changed: expected ${input.expectedCodexPlanDigest}, got ${planned.digest}`);
  }

  const source = openReadOnlyDatabase(sourcePath);
  try {
    assertNoActiveProjectionRun(source);
    if (sourceState(source).digest !== input.expectedSourceDigest) {
      throw new Error("Maintenance source changed immediately before candidate backup");
    }
    await backup(source, candidatePath);
    if (sourceState(source).digest !== input.expectedSourceDigest) {
      throw new Error("Maintenance source changed while the candidate backup was being created");
    }
  } finally {
    source.close();
  }

  const at = input.now?.() ?? new Date().toISOString();
  const objectStore = new ZstdContentObjectStore(input.stateRoot);
  const candidate = openMaintenanceDatabase(candidatePath);
  let failedStage: ConversationTopologyRepairStage = "repair.checkpoint";
  try {
    assertNoActiveProjectionRun(candidate);
    const repository = new SqliteSessionRepository(candidate, objectStore);
    const checkpointId = `checkpoint-m06-${randomUUID()}` as CheckpointId;
    const checkpoint: Checkpoint = {
      id: checkpointId,
      name: "M06 会话拓扑修复前 Checkpoint",
      description: "候选库内记录旧 Codex 镜像与 DSH 派生会话活动头；源库和 Codex 真源未修改。",
      refs: checkpointRefs(candidate),
      backupTransactionIds: [],
      createdBy: "conversation-topology-repair-m06",
      createdAt: at,
    };
    await status(input.onStatus, "repair.checkpoint", "started", `refs=${Object.keys(checkpoint.refs).length}`);
    await repository.saveCheckpoint(checkpoint);
    await status(input.onStatus, "repair.checkpoint", "succeeded", checkpointId);

    const oldMirrorIds = mirrorIds(candidate);
    const selectedMirrorIds = new Set(planned.plan.sessions.map((item) => String(item.logicalSessionId)));
    const oldDerivations = derivations(candidate);
    const store = new SqliteCanonicalSessionEngineStore(candidate, objectStore);
    const engine = new CanonicalSessionEngine(store);
    const evidence = new SqliteAdapterEvidenceStore(candidate, objectStore, { clock: () => at });

    failedStage = "repair.mirror-write";
    await status(input.onStatus, "repair.mirror-write", "started", `mirrors=${planned.plan.sessions.length}`);
    const codexImportCounts = {
      scanned: planned.plan.scanned,
      created: 0,
      advanced: 0,
      noop: 0,
      retried: 0,
    };
    const projectPort = new SqliteCodexProjectPort(new SqliteCanonicalRepository(candidate));
    const replayedPlan = await visitCodexCanonicalImportPlan({
      instance: input.codexInstance,
      ...(input.fixtureGuard === undefined ? {} : { fixtureGuard: input.fixtureGuard }),
      visitSession: async (item) => {
        const applied = await applyCodexCanonicalImportPlan({
          plan: {
            schemaVersion: 1,
            instanceId: planned.plan.instanceId,
            scanned: 1,
            retried: 0,
            sessions: [item],
            projectAssignments: planned.plan.projectAssignments,
          },
          canonicalEngine: engine,
          projectPort,
          evidencePort: evidence,
        });
        codexImportCounts.created += applied.created;
        codexImportCounts.advanced += applied.advanced;
        codexImportCounts.noop += applied.noop;
      },
    });
    if (replayedPlan.retried > 0 || planDigest(replayedPlan) !== input.expectedCodexPlanDigest) {
      throw new Error("Codex source changed between repair planning and candidate import");
    }
    const codexImport: CodexCanonicalImportResult = {
      ...codexImportCounts,
      projectAssignments: planned.plan.projectAssignments,
    };
    const retired = oldMirrorIds.filter((id) => !selectedMirrorIds.has(id));
    for (const logicalSessionId of retired) {
      const snapshot = await store.getSession(logicalSessionId as LogicalSessionId);
      if (snapshot === undefined || snapshot.tombstone?.restoredAt === null) continue;
      await engine.tombstone({
        logicalSessionId: logicalSessionId as LogicalSessionId,
        operationId: `operation-m06-retire-${sha256Canonical(logicalSessionId as unknown as JsonValue).slice(7, 31)}` as OperationId,
        checkpointId,
        deletedAt: at,
        retentionUntil: "9999-12-31T23:59:59.999Z",
      });
    }
    await status(input.onStatus, "repair.mirror-write", "succeeded", `advanced=${codexImport.advanced}; noop=${codexImport.noop}; retired=${retired.length}`);

    failedStage = "repair.derived-recompose";
    await status(input.onStatus, "repair.derived-recompose", "started", `derivations=${oldDerivations.length}`);
    const recomposed = await recomposeDerivedSessions({
      database: candidate,
      store,
      rows: oldDerivations,
      refreshedParents: selectedMirrorIds,
      at,
    });
    await status(input.onStatus, "repair.derived-recompose", "succeeded", `recomposed=${recomposed.length}`);

    const verifyIds = [...new Set([
      ...planned.plan.sessions.map((item) => item.logicalSessionId),
      ...recomposed,
    ])];
    failedStage = "repair.rc1-verify";
    await status(input.onStatus, "repair.rc1-verify", "started", `sessions=${verifyIds.length}`);
    const verifiedRc1Sessions = await verifyRc1Sessions({
      database: candidate,
      objectStore,
      logicalSessionIds: verifyIds,
      at,
    });
    verifyDatabase(candidate);
    await status(input.onStatus, "repair.rc1-verify", "succeeded", `verified=${verifiedRc1Sessions}`);
    candidate.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    candidate.close();

    const candidateDigest = await fileDigest(candidatePath);
    const manifest: ConversationTopologyRepairManifestV1 = {
      schemaVersion: 1,
      migrationKind: "mcsf-conversation-topology-rc1",
      createdAt: at,
      sourceDatabasePath: sourcePath,
      sourceDigest: input.expectedSourceDigest,
      codexPlanDigest: input.expectedCodexPlanDigest,
      candidateDatabasePath: candidatePath,
      candidateDigest,
      checkpointId,
      codexImport,
      retiredCodexMirrors: retired.length,
      recomposedDerivedSessions: recomposed.length,
      verifiedRc1Sessions,
      integrityCheck: "ok",
      foreignKeyViolations: 0,
    };
    failedStage = "repair.candidate-ready";
    await writeManifest(manifestPath(candidatePath), manifest);
    await status(input.onStatus, "repair.candidate-ready", "succeeded", `candidate=${candidateDigest}`);
    return manifest;
  } catch (error) {
    try { candidate.close(); } catch { /* preserve repair failure */ }
    const detail = error instanceof Error ? error.message : "unknown failure";
    await status(input.onStatus, failedStage, "failed", detail);
    if (failedStage !== "repair.candidate-ready") {
      await status(input.onStatus, "repair.candidate-ready", "failed", detail);
    }
    throw error;
  }
}

export async function activateConversationTopologyRepairCandidate(input: {
  readonly stateRoot: string;
  readonly sourceDatabasePath: string;
  readonly candidateFile: string;
  readonly expectedSourceDigest: string;
  readonly expectedCandidateDigest: string;
  readonly activateDatabaseFile: (candidateFile: string) => Promise<void>;
}): Promise<{ readonly activeDatabaseFile: string; readonly restartRequired: true }> {
  const sourcePath = resolveSourcePath(input.stateRoot, input.sourceDatabasePath);
  const candidatePath = resolveCandidatePath(input.stateRoot, input.candidateFile);
  const manifest = JSON.parse(await readFile(manifestPath(candidatePath), "utf8")) as ConversationTopologyRepairManifestV1;
  if (manifest.migrationKind !== "mcsf-conversation-topology-rc1"
    || manifest.sourceDigest !== input.expectedSourceDigest
    || manifest.candidateDigest !== input.expectedCandidateDigest
    || manifest.sourceDatabasePath !== sourcePath
    || manifest.candidateDatabasePath !== candidatePath) {
    throw new Error("Conversation repair manifest does not match the requested activation");
  }
  const source = openReadOnlyDatabase(sourcePath);
  try {
    assertNoActiveProjectionRun(source);
    if (sourceState(source).digest !== input.expectedSourceDigest) {
      throw new Error("Maintenance source changed after the repair candidate was staged");
    }
  } finally {
    source.close();
  }
  if (await fileDigest(candidatePath) !== input.expectedCandidateDigest) {
    throw new Error("Conversation repair candidate digest changed after validation");
  }
  const candidate = openReadOnlyDatabase(candidatePath);
  try {
    verifyDatabase(candidate);
  } finally {
    candidate.close();
  }
  await input.activateDatabaseFile(input.candidateFile);
  return { activeDatabaseFile: input.candidateFile, restartRequired: true };
}
