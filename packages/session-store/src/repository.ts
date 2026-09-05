import type { DatabaseSync } from "node:sqlite";

import {
  CONTRACT_SCHEMA_VERSION,
  SessionMaintenanceError,
  backupManifestSchema,
  checkpointSchema,
  continuationJobSchema,
  continuationTransitionSchema,
  matchCandidateSchema,
  nativeMirrorRecordSchema,
  observedHeadSchema,
  platformBindingSchema,
  sessionVersionManifestSchema,
  storedConfirmationSchema,
  syncPlanSchema,
  transactionRecordSchema,
  transactionStepSchema,
  type BackupManifest,
  type BackupProtection,
  type Checkpoint,
  type ContinuationJob,
  type ContinuationTransition,
  type ContentObjectStore,
  type JsonValue,
  type LogicalSession,
  type MatchCandidate,
  type NativeMirrorRecord,
  type NewVersion,
  type ObservationRecord,
  type ObservedHead,
  type Page,
  type PlatformBinding,
  type PlatformKind,
  type PlatformSessionKey,
  type RepositoryCounts,
  type RepositoryWriteResult,
  type SessionQuery,
  type SessionStatus,
  type SessionSummary,
  type WorkspaceSummary,
  type SessionVersionManifest,
  type SyncPlan,
  type StoredConfirmation,
  type TransactionRecord,
  type TransactionStep,
  type TransactionTransition,
  type TransactionQuery,
  type TransactionSummary,
  type PlanQuery,
  type PlanSummary,
  type VersionGraphData,
  type VersionGraphPage,
  type VerifiedRefAdvance,
} from "@linmu/dsh-session-contracts";
import {
  canonicalJson,
  verifySyncPlanIdentity,
  versionIdFor,
} from "@linmu/dsh-session-domain";

import { metadataFromStoredBody, saveVersionMetadataSnapshot } from "./version-metadata.js";
import { advanceCanonicalSessionMetadata } from "./canonical-metadata.js";

import { SqliteCanonicalRepository } from "./canonical-repository.js";

interface ManifestRow {
  readonly manifest_json: string;
}

interface VersionRow {
  readonly id: string;
}

interface ParentRow {
  readonly version_id: string;
  readonly parent_id: string;
}

interface ObjectRow {
  readonly body_object: string;
}

interface PlanRow {
  readonly id: string;
  readonly hash: string;
  readonly plan_json: string;
}

interface ContinuationJobRow {
  readonly id: string;
  readonly request_hash: string;
  readonly request_json: string;
  readonly logical_session_id: string;
  readonly source_version_ids_json: string;
  readonly target_preset_id: string;
  readonly mode: ContinuationJob["mode"];
  readonly handoff_object_id: string;
  readonly status: ContinuationJob["status"];
  readonly codex_thread_id: string | null;
  readonly codex_turn_id: string | null;
  readonly error_code: string | null;
  readonly verification_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface BindingRow {
  readonly id: string;
  readonly logical_session_id: string;
  readonly platform: PlatformKind;
  readonly instance_id: string;
  readonly session_id: string;
  readonly adapter_contract_json: string;
  readonly last_common_version_id: string | null;
  readonly status: PlatformBinding["status"];
}

interface HeadRow {
  readonly binding_id: string;
  readonly version_id: string;
  readonly observed_at: string;
  readonly fingerprint_json: string;
}

interface CandidateRow {
  readonly id: string;
  readonly left_binding_id: string;
  readonly right_key_json: string;
  readonly reason: string;
  readonly confidence: MatchCandidate["confidence"];
  readonly created_at: string;
  readonly resolved_at: string | null;
}

interface CountRow {
  readonly count: number;
}

interface SessionRow {
  readonly id: string;
  readonly display_title: string;
  readonly archived: number;
  readonly created_at: string;
  readonly platforms: string | null;
  readonly binding_count: number;
  readonly head_count: number;
  readonly distinct_heads: number;
  readonly updated_at: string | null;
  readonly workspace_id: string | null;
  readonly workspace_name: string | null;
}

interface TransactionRow {
  readonly id: string;
  readonly plan_id: string;
  readonly plan_hash: string;
  readonly platform: PlatformKind;
  readonly instance_id: string;
  readonly root_identity: string;
  readonly adapter_contract_json: string;
  readonly status: TransactionRecord["status"];
  readonly result_json: string | null;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface NativeMirrorRow {
  readonly logical_session_id: string;
  readonly state: NativeMirrorRecord["state"];
  readonly codex_binding_id: string | null;
  readonly dsh_binding_id: string | null;
  readonly common_version_id: string | null;
  readonly codex_version_id: string | null;
  readonly dsh_version_id: string | null;
  readonly last_transaction_id: string | null;
  readonly pause_reason: string | null;
  readonly updated_at: string;
}

interface BackupManifestRow {
  readonly manifest_hash: string;
  readonly manifest_json: string;
}

interface CheckpointRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly refs_json: string;
  readonly backup_transaction_ids_json: string;
  readonly created_by: string;
  readonly created_at: string;
}

interface ConfirmationRow {
  readonly token_hash: string;
  readonly operation: string;
  readonly resource_id: string;
  readonly operation_hash: string;
  readonly expires_at: string;
  readonly created_at: string;
  readonly consumed_at: string | null;
}

interface TransactionStepRow {
  readonly transaction_id: string;
  readonly sequence: number;
  readonly status: TransactionStep["status"];
  readonly step: string;
  readonly data_json: string;
  readonly previous_hash: string | null;
  readonly entry_hash: string;
  readonly created_at: string;
}

type JsonObject = { readonly [key: string]: JsonValue };

function issueJson(issue: NewVersion["compatibility"]["issues"][number]): JsonValue {
  return {
    code: issue.code,
    message: issue.message,
    ...(issue.sourceType === undefined ? {} : { sourceType: issue.sourceType }),
  };
}

function newVersionJson(input: NewVersion): JsonObject {
  return {
    logicalSessionId: input.logicalSessionId,
    parents: [...input.parents],
    bodyObject: input.bodyObject,
    bodyHash: input.bodyHash,
    metadataHash: input.metadataHash,
    source: {
      platform: input.source.platform,
      instanceId: input.source.instanceId,
      sessionId: input.source.sessionId,
      observedAt: input.source.observedAt,
      ...(input.source.sourceVersion === undefined
        ? {}
        : { sourceVersion: input.source.sourceVersion }),
    },
    compatibility: {
      status: input.compatibility.status,
      issues: input.compatibility.issues.map(issueJson),
    },
  };
}

function manifestJson(manifest: SessionVersionManifest): string {
  return canonicalJson({
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    ...newVersionJson(manifest),
  });
}

function bindingJson(row: BindingRow): PlatformBinding {
  return platformBindingSchema.parse({
    id: row.id,
    logicalSessionId: row.logical_session_id,
    key: { platform: row.platform, instanceId: row.instance_id, sessionId: row.session_id },
    adapterContract: JSON.parse(row.adapter_contract_json) as unknown,
    lastCommonVersionId: row.last_common_version_id,
    status: row.status,
  });
}

function candidateJson(row: CandidateRow): MatchCandidate {
  return matchCandidateSchema.parse({
    id: row.id,
    leftBindingId: row.left_binding_id,
    rightKey: JSON.parse(row.right_key_json) as unknown,
    reason: row.reason,
    confidence: row.confidence,
    createdAt: row.created_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
  }) as unknown as MatchCandidate;
}

function headJson(row: HeadRow): ObservedHead {
  return observedHeadSchema.parse({
    bindingId: row.binding_id,
    versionId: row.version_id,
    observedAt: row.observed_at,
    fingerprint: JSON.parse(row.fingerprint_json) as unknown,
  });
}

function sessionSummary(row: SessionRow): SessionSummary {
  const platforms = (row.platforms?.split(",") ?? []).sort() as PlatformKind[];
  const status: SessionStatus =
    row.binding_count < 2 || row.head_count < 2
      ? "unmapped"
      : row.distinct_heads === 1
        ? "equal"
        : "diverged";
  return {
    logicalSessionId: row.id,
    title: row.display_title,
    archived: Boolean(row.archived),
    platforms,
    status,
    updatedAt: row.updated_at ?? row.created_at,
    workspace: row.workspace_id === null
      ? null
      : { id: row.workspace_id, name: row.workspace_name ?? row.workspace_id },
  };
}

function versionIdentity(manifest: SessionVersionManifest): JsonValue {
  return {
    logicalSessionId: manifest.logicalSessionId,
    parents: manifest.parents,
    bodyHash: manifest.bodyHash,
    metadataHash: manifest.metadataHash,
  };
}

function expectedVersionId(manifest: SessionVersionManifest): string {
  return versionIdFor({
    logicalSessionId: manifest.logicalSessionId,
    parents: manifest.parents,
    bodyHash: manifest.bodyHash,
    metadataHash: manifest.metadataHash,
  });
}

function parseManifest(serialized: string, id: string): SessionVersionManifest {
  try {
    const parsed = sessionVersionManifestSchema.parse(
      JSON.parse(serialized) as unknown,
    ) as unknown as SessionVersionManifest;
    if (parsed.id !== id || expectedVersionId(parsed) !== id) throw new Error("identity mismatch");
    return parsed;
  } catch (error) {
    throw new SessionMaintenanceError("VERSION_ID_COLLISION", `Stored version identity is corrupt: ${id}`, {
      cause: error,
    });
  }
}

function transactionJson(row: TransactionRow): TransactionRecord {
  return transactionRecordSchema.parse({
    id: row.id,
    planId: row.plan_id,
    planHash: row.plan_hash,
    platform: row.platform,
    instanceId: row.instance_id,
    rootIdentity: row.root_identity,
    adapterContract: JSON.parse(row.adapter_contract_json) as unknown,
    status: row.status,
    ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as unknown }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }) as TransactionRecord;
}

function nativeMirrorJson(row: NativeMirrorRow): NativeMirrorRecord {
  return nativeMirrorRecordSchema.parse({
    logicalSessionId: row.logical_session_id,
    state: row.state,
    codexBindingId: row.codex_binding_id,
    dshBindingId: row.dsh_binding_id,
    commonVersionId: row.common_version_id,
    codexVersionId: row.codex_version_id,
    dshVersionId: row.dsh_version_id,
    lastTransactionId: row.last_transaction_id,
    pauseReason: row.pause_reason,
    updatedAt: row.updated_at,
  }) as NativeMirrorRecord;
}

function continuationJobJson(row: ContinuationJobRow): ContinuationJob {
  return continuationJobSchema.parse({
    id: row.id,
    requestHash: row.request_hash,
    request: JSON.parse(row.request_json) as unknown,
    logicalSessionId: row.logical_session_id,
    sourceVersionIds: JSON.parse(row.source_version_ids_json) as unknown,
    targetPresetId: row.target_preset_id,
    mode: row.mode,
    handoffObjectId: row.handoff_object_id,
    status: row.status,
    ...(row.codex_thread_id === null ? {} : { codexThreadId: row.codex_thread_id }),
    ...(row.codex_turn_id === null ? {} : { codexTurnId: row.codex_turn_id }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.verification_json === null ? {} : { verification: JSON.parse(row.verification_json) as unknown }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }) as ContinuationJob;
}

function checkpointJson(row: CheckpointRow): Checkpoint {
  return checkpointSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    refs: JSON.parse(row.refs_json) as unknown,
    backupTransactionIds: JSON.parse(row.backup_transaction_ids_json) as unknown,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }) as Checkpoint;
}

function confirmationJson(row: ConfirmationRow): StoredConfirmation {
  return storedConfirmationSchema.parse({
    tokenHash: row.token_hash,
    operation: row.operation,
    resourceId: row.resource_id,
    operationHash: row.operation_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
  }) as StoredConfirmation;
}

export class SqliteSessionRepository {
  readonly database: DatabaseSync;
  readonly objectStore: ContentObjectStore;
  readonly canonical: SqliteCanonicalRepository;

  constructor(database: DatabaseSync, objectStore: ContentObjectStore) {
    this.database = database;
    this.objectStore = objectStore;
    this.canonical = new SqliteCanonicalRepository(database);
  }

  async createLogicalSession(input: LogicalSession): Promise<boolean> {
    const existing = this.database
      .prepare(
        `SELECT display_title, canonical_version_id, sync_mode, archived, labels_json, created_at
         FROM logical_sessions WHERE id = ?`,
      )
      .get(input.id) as
      | {
          readonly display_title: string;
          readonly canonical_version_id: string | null;
          readonly sync_mode: string;
          readonly archived: number;
          readonly labels_json: string;
          readonly created_at: string;
        }
      | undefined;
    if (existing !== undefined) {
      const same =
        existing.display_title === input.displayTitle &&
        existing.canonical_version_id === input.canonicalVersionId &&
        existing.sync_mode === input.syncMode &&
        Boolean(existing.archived) === input.archived &&
        existing.labels_json === canonicalJson([...input.labels]) &&
        existing.created_at === input.createdAt;
      if (!same) {
        throw new SessionMaintenanceError(
          "IDENTITY_CONFLICT",
          `Logical session ID already has different content: ${input.id}`,
        );
      }
      return false;
    }

    this.database
      .prepare(
        `INSERT INTO logical_sessions
          (id, display_title, canonical_version_id, sync_mode, archived, labels_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.displayTitle,
        input.canonicalVersionId,
        input.syncMode,
        input.archived ? 1 : 0,
        canonicalJson([...input.labels]),
        input.createdAt,
      );
    return true;
  }

  async getNativeMirror(logicalSessionId: string): Promise<NativeMirrorRecord | undefined> {
    const row = this.database.prepare(`SELECT logical_session_id, state, codex_binding_id,
      dsh_binding_id, common_version_id, codex_version_id, dsh_version_id,
      last_transaction_id, pause_reason, updated_at FROM native_mirrors
      WHERE logical_session_id = ?`).get(logicalSessionId) as NativeMirrorRow | undefined;
    return row === undefined ? undefined : nativeMirrorJson(row);
  }

  async listNativeMirrors(): Promise<readonly NativeMirrorRecord[]> {
    const rows = this.database.prepare(`SELECT logical_session_id, state, codex_binding_id,
      dsh_binding_id, common_version_id, codex_version_id, dsh_version_id,
      last_transaction_id, pause_reason, updated_at FROM native_mirrors
      ORDER BY updated_at DESC, logical_session_id`).all() as unknown as NativeMirrorRow[];
    return rows.map(nativeMirrorJson);
  }

  async upsertNativeMirror(input: NativeMirrorRecord): Promise<NativeMirrorRecord> {
    nativeMirrorRecordSchema.parse(input);
    this.database.prepare(`INSERT INTO native_mirrors
      (logical_session_id, state, codex_binding_id, dsh_binding_id, common_version_id,
       codex_version_id, dsh_version_id, last_transaction_id, pause_reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(logical_session_id) DO UPDATE SET
        state = excluded.state,
        codex_binding_id = excluded.codex_binding_id,
        dsh_binding_id = excluded.dsh_binding_id,
        common_version_id = excluded.common_version_id,
        codex_version_id = excluded.codex_version_id,
        dsh_version_id = excluded.dsh_version_id,
        last_transaction_id = excluded.last_transaction_id,
        pause_reason = excluded.pause_reason,
        updated_at = excluded.updated_at`).run(
      input.logicalSessionId, input.state, input.codexBindingId, input.dshBindingId,
      input.commonVersionId, input.codexVersionId, input.dshVersionId,
      input.lastTransactionId, input.pauseReason, input.updatedAt,
    );
    return (await this.getNativeMirror(input.logicalSessionId))!;
  }

  async removeNativeMirror(logicalSessionId: string): Promise<boolean> {
    return Number(this.database.prepare("DELETE FROM native_mirrors WHERE logical_session_id = ?").run(logicalSessionId).changes) === 1;
  }

  async setLogicalSessionSyncMode(logicalSessionId: string, mode: LogicalSession["syncMode"]): Promise<void> {
    const result = this.database.prepare("UPDATE logical_sessions SET sync_mode = ? WHERE id = ?").run(mode, logicalSessionId);
    if (Number(result.changes) !== 1) throw new SessionMaintenanceError("OBJECT_CORRUPT", `Logical session is missing: ${logicalSessionId}`);
  }

  async setCanonicalVersion(logicalSessionId: string, versionId: string): Promise<void> {
    const version = await this.getVersion(versionId);
    if (version?.logicalSessionId !== logicalSessionId) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", "Canonical version does not belong to the logical session");
    }
    const result = this.database.prepare("UPDATE logical_sessions SET canonical_version_id = ? WHERE id = ?").run(versionId, logicalSessionId);
    if (Number(result.changes) !== 1) throw new SessionMaintenanceError("OBJECT_CORRUPT", `Logical session is missing: ${logicalSessionId}`);
  }

  async putVersion(input: NewVersion): Promise<SessionVersionManifest> {
    const storedBody = await this.objectStore.get(input.bodyObject);
    const metadata = metadataFromStoredBody(storedBody, input.metadataHash);
    const id = versionIdFor({
      logicalSessionId: input.logicalSessionId,
      parents: input.parents,
      bodyHash: input.bodyHash,
      metadataHash: input.metadataHash,
    });
    const manifest: SessionVersionManifest = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      id,
      logicalSessionId: input.logicalSessionId,
      parents: [...input.parents],
      bodyObject: input.bodyObject,
      bodyHash: input.bodyHash,
      metadataHash: input.metadataHash,
      source: {
        platform: input.source.platform,
        instanceId: input.source.instanceId,
        sessionId: input.source.sessionId,
        observedAt: input.source.observedAt,
        ...(input.source.sourceVersion === undefined
          ? {}
          : { sourceVersion: input.source.sourceVersion }),
      },
      compatibility: {
        status: input.compatibility.status,
        issues: input.compatibility.issues.map((issue) => ({
          code: issue.code,
          message: issue.message,
          ...(issue.sourceType === undefined ? {} : { sourceType: issue.sourceType }),
        })),
      },
    };
    const serialized = manifestJson(manifest);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare("SELECT manifest_json FROM session_versions WHERE id = ?")
        .get(id) as ManifestRow | undefined;
      if (existing !== undefined) {
        const parsed = parseManifest(existing.manifest_json, id);
        if (canonicalJson(versionIdentity(parsed)) !== canonicalJson(versionIdentity(manifest))) {
          throw new SessionMaintenanceError(
            "VERSION_ID_COLLISION",
            `Version ID has different immutable content: ${id}`,
          );
        }
        if (metadata !== undefined) saveVersionMetadataSnapshot(this.database, id, metadata, "reconstructed-body");
        this.database.exec("COMMIT");
        return parsed;
      }

      this.database
        .prepare(
          `INSERT INTO session_versions
            (id, logical_session_id, body_object, body_hash, metadata_hash, manifest_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.logicalSessionId,
          input.bodyObject,
          input.bodyHash,
          input.metadataHash,
          serialized,
          input.source.observedAt,
        );
      const insertParent = this.database.prepare(
        "INSERT INTO version_parents (version_id, ordinal, parent_id) VALUES (?, ?, ?)",
      );
      input.parents.forEach((parent, ordinal) => insertParent.run(id, ordinal, parent));
      if (metadata !== undefined) saveVersionMetadataSnapshot(this.database, id, metadata, "reconstructed-body");
      this.database.exec("COMMIT");
      return manifest;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    }
  }

  async getVersion(id: string): Promise<SessionVersionManifest | undefined> {
    const row = this.database
      .prepare("SELECT manifest_json FROM session_versions WHERE id = ?")
      .get(id) as ManifestRow | undefined;
    return row === undefined ? undefined : parseManifest(row.manifest_json, id);
  }

  async advanceVerifiedRefs(input: VerifiedRefAdvance): Promise<void> {
    if (
      input.targetBinding.logicalSessionId !== input.logicalSessionId ||
      input.verifiedHead.bindingId !== input.targetBinding.id ||
      input.verifiedHead.fingerprint.platform !== input.targetBinding.key.platform ||
      input.verifiedHead.fingerprint.instanceId !== input.targetBinding.key.instanceId ||
      input.verifiedHead.fingerprint.sessionId !== input.targetBinding.key.sessionId
    ) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", "Verified ref transition contains inconsistent identities");
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const source = this.database
        .prepare(
          `SELECT pb.logical_session_id, pr.version_id
           FROM platform_bindings pb
           JOIN platform_refs pr ON pr.binding_id = pb.id
           WHERE pb.id = ?`,
        )
        .get(input.sourceBindingId) as
        | { readonly logical_session_id: string; readonly version_id: string }
        | undefined;
      if (
        source?.logical_session_id !== input.logicalSessionId ||
        (source.version_id !== input.expectedSourceVersionId &&
          source.version_id !== input.verifiedHead.versionId)
      ) {
        throw new SessionMaintenanceError("PLAN_STALE", "Source ref changed before verified ref advance");
      }

      const version = this.database
        .prepare("SELECT logical_session_id FROM session_versions WHERE id = ?")
        .get(input.verifiedHead.versionId) as { readonly logical_session_id: string } | undefined;
      if (version?.logical_session_id !== input.logicalSessionId) {
        throw new SessionMaintenanceError("OBJECT_CORRUPT", "Verified version is missing from the logical session");
      }

      const existing = this.database
        .prepare(
          `SELECT id, logical_session_id, platform, instance_id, session_id,
                  adapter_contract_json, last_common_version_id, status
           FROM platform_bindings WHERE id = ?`,
        )
        .get(input.targetBinding.id) as BindingRow | undefined;
      if (existing === undefined) {
        const occupied = this.database
          .prepare(
            `SELECT id FROM platform_bindings
             WHERE platform = ? AND instance_id = ? AND session_id = ?`,
          )
          .get(
            input.targetBinding.key.platform,
            input.targetBinding.key.instanceId,
            input.targetBinding.key.sessionId,
          );
        if (occupied !== undefined || input.expectedTargetVersionId !== undefined) {
          throw new SessionMaintenanceError("PLAN_STALE", "Platform target binding changed before verified ref advance");
        }
        this.database
          .prepare(
            `INSERT INTO platform_bindings
              (id, logical_session_id, platform, instance_id, session_id, adapter_contract_json,
               last_common_version_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.targetBinding.id,
            input.targetBinding.logicalSessionId,
            input.targetBinding.key.platform,
            input.targetBinding.key.instanceId,
            input.targetBinding.key.sessionId,
            canonicalJson(input.targetBinding.adapterContract as unknown as JsonValue),
            input.targetBinding.lastCommonVersionId,
            input.targetBinding.status,
          );
      } else {
        const binding = bindingJson(existing);
        if (
          binding.logicalSessionId !== input.logicalSessionId ||
          binding.key.platform !== input.targetBinding.key.platform ||
          binding.key.instanceId !== input.targetBinding.key.instanceId ||
          binding.key.sessionId !== input.targetBinding.key.sessionId
        ) {
          throw new SessionMaintenanceError("IDENTITY_CONFLICT", "Platform target binding identity changed");
        }
        const head = this.database
          .prepare("SELECT version_id FROM platform_refs WHERE binding_id = ?")
          .get(binding.id) as { readonly version_id: string } | undefined;
        const expected = input.expectedTargetVersionId;
        if (head?.version_id !== expected && head?.version_id !== input.verifiedHead.versionId) {
          throw new SessionMaintenanceError("PLAN_STALE", "Platform target ref changed before verified ref advance");
        }
      }

      this.database
        .prepare(
          `INSERT INTO platform_refs (binding_id, version_id, observed_at, fingerprint_json)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(binding_id) DO UPDATE SET
             version_id = excluded.version_id,
             observed_at = excluded.observed_at,
             fingerprint_json = excluded.fingerprint_json`,
        )
        .run(
          input.verifiedHead.bindingId,
          input.verifiedHead.versionId,
          input.verifiedHead.observedAt,
          canonicalJson(input.verifiedHead.fingerprint as unknown as JsonValue),
        );
      if (source.version_id !== input.verifiedHead.versionId) {
        const sourceAdvance = this.database
          .prepare(
            `UPDATE platform_refs
             SET version_id = ?
             WHERE binding_id = ? AND version_id = ?`,
          )
          .run(
            input.verifiedHead.versionId,
            input.sourceBindingId,
            input.expectedSourceVersionId,
          );
        if (Number(sourceAdvance.changes) !== 1) {
          throw new SessionMaintenanceError("PLAN_STALE", "Source ref changed before common version advance");
        }
      }
      this.database
        .prepare("UPDATE platform_bindings SET last_common_version_id = ? WHERE id IN (?, ?)")
        .run(input.verifiedHead.versionId, input.sourceBindingId, input.targetBinding.id);
      this.database
        .prepare(
          `UPDATE logical_sessions
           SET canonical_version_id = ?, display_title = ?, archived = ?
           WHERE id = ?`,
        )
        .run(
          input.verifiedHead.versionId,
          input.displayTitle,
          input.archived ? 1 : 0,
          input.logicalSessionId,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    }
  }

  async recordObservation(input: ObservedHead): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO platform_refs (binding_id, version_id, observed_at, fingerprint_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(binding_id) DO UPDATE SET
           version_id = excluded.version_id,
           observed_at = excluded.observed_at,
           fingerprint_json = excluded.fingerprint_json`,
      )
      .run(
        input.bindingId,
        input.versionId,
        input.observedAt,
        canonicalJson({
          platform: input.fingerprint.platform,
          instanceId: input.fingerprint.instanceId,
          sessionId: input.fingerprint.sessionId,
          kind: input.fingerprint.kind,
          value: input.fingerprint.value,
        }),
      );
  }

  async findBinding(key: PlatformSessionKey): Promise<PlatformBinding | undefined> {
    const row = this.database
      .prepare(
        `SELECT id, logical_session_id, platform, instance_id, session_id,
                adapter_contract_json, last_common_version_id, status
         FROM platform_bindings
         WHERE platform = ? AND instance_id = ? AND session_id = ?`,
      )
      .get(key.platform, key.instanceId, key.sessionId) as BindingRow | undefined;
    return row === undefined ? undefined : bindingJson(row);
  }

  async bindPlatformSession(input: PlatformBinding): Promise<boolean> {
    platformBindingSchema.parse(input);
    const existing = await this.findBinding(input.key);
    if (existing !== undefined) {
      if (canonicalJson(existing as unknown as JsonValue) !== canonicalJson(input as unknown as JsonValue)) {
        throw new SessionMaintenanceError(
          "IDENTITY_CONFLICT",
          `Platform key already has a different binding: ${input.key.platform}/${input.key.instanceId}/${input.key.sessionId}`,
        );
      }
      return false;
    }
    this.database
      .prepare(
        `INSERT INTO platform_bindings
          (id, logical_session_id, platform, instance_id, session_id, adapter_contract_json,
           last_common_version_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.logicalSessionId,
        input.key.platform,
        input.key.instanceId,
        input.key.sessionId,
        canonicalJson(input.adapterContract as unknown as JsonValue),
        input.lastCommonVersionId,
        input.status,
      );
    return true;
  }

  async recordWorkspaceMembership(input: {
    readonly bindingId: string;
    readonly workspaceId: string | null;
    readonly displayName: string | null;
  }): Promise<void> {
    if (input.workspaceId === null) {
      this.database.prepare("DELETE FROM binding_workspaces WHERE binding_id = ?").run(input.bindingId);
      return;
    }
    const displayName = input.displayName?.trim() || input.workspaceId;
    this.database
      .prepare(
        `INSERT INTO binding_workspaces (binding_id, workspace_id, display_name)
         VALUES (?, ?, ?)
         ON CONFLICT(binding_id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           display_name = excluded.display_name`,
      )
      .run(input.bindingId, input.workspaceId, displayName);
  }

  async getObservedHead(bindingId: string): Promise<ObservedHead | undefined> {
    const row = this.database
      .prepare(
        `SELECT binding_id, version_id, observed_at, fingerprint_json
         FROM platform_refs WHERE binding_id = ?`,
      )
      .get(bindingId) as HeadRow | undefined;
    return row === undefined ? undefined : headJson(row);
  }

  async upsertMatchCandidate(input: MatchCandidate): Promise<boolean> {
    matchCandidateSchema.parse(input);
    const left = this.database
      .prepare("SELECT logical_session_id FROM platform_bindings WHERE id = ?")
      .get(input.leftBindingId) as { readonly logical_session_id: string } | undefined;
    if (left === undefined) throw new SessionMaintenanceError("OBJECT_CORRUPT", `Missing candidate binding: ${input.leftBindingId}`);
    const existing = this.database
      .prepare(
        `SELECT id, left_binding_id, right_key_json, reason, confidence, created_at, resolved_at
         FROM match_candidates WHERE id = ?`,
      )
      .get(input.id) as CandidateRow | undefined;
    if (existing !== undefined) {
      if (canonicalJson(candidateJson(existing) as unknown as JsonValue) !== canonicalJson(input as unknown as JsonValue)) {
        throw new SessionMaintenanceError("IDENTITY_CONFLICT", `Match candidate ID has different content: ${input.id}`);
      }
      return false;
    }
    this.database
      .prepare(
        `INSERT INTO match_candidates
          (id, logical_session_id, left_binding_id, right_key_json, reason, confidence, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        left.logical_session_id,
        input.leftBindingId,
        canonicalJson(input.rightKey as unknown as JsonValue),
        input.reason,
        input.confidence,
        input.createdAt,
        input.resolvedAt ?? null,
      );
    return true;
  }

  async listMatchCandidates(logicalSessionId: string): Promise<readonly MatchCandidate[]> {
    const rows = this.database
      .prepare(
        `SELECT id, left_binding_id, right_key_json, reason, confidence, created_at, resolved_at
         FROM match_candidates WHERE logical_session_id = ? ORDER BY created_at, id`,
      )
      .all(logicalSessionId) as unknown as CandidateRow[];
    return rows.map(candidateJson);
  }

  async listBindings(logicalSessionId: string): Promise<readonly PlatformBinding[]> {
    const rows = this.database
      .prepare(
        `SELECT id, logical_session_id, platform, instance_id, session_id,
                adapter_contract_json, last_common_version_id, status
         FROM platform_bindings WHERE logical_session_id = ? ORDER BY platform, instance_id, session_id`,
      )
      .all(logicalSessionId) as unknown as BindingRow[];
    return rows.map(bindingJson);
  }

  async counts(): Promise<RepositoryCounts> {
    const count = (table: string): number =>
      (this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as CountRow).count;
    return {
      logicalSessions: count("logical_sessions"),
      bindings: count("platform_bindings"),
      versions: count("session_versions"),
      candidates: count("match_candidates"),
      plans: count("sync_plans"),
    };
  }

  async recordObservedVersion(input: ObservationRecord): Promise<RepositoryWriteResult> {
    if (expectedVersionId(input.version) !== input.version.id) {
      throw new SessionMaintenanceError("VERSION_ID_COLLISION", `Version identity does not match: ${input.version.id}`);
    }
    if (
      input.version.logicalSessionId !== input.logicalSession.id ||
      input.binding.logicalSessionId !== input.logicalSession.id ||
      input.head.bindingId !== input.binding.id ||
      input.head.versionId !== input.version.id
    ) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", "Observation record contains inconsistent identities");
    }
    const storedBody = await this.objectStore.get(input.version.bodyObject);
    const metadata = metadataFromStoredBody(storedBody, input.version.metadataHash);

    let createdLogicalSessions = 0;
    let createdBindings = 0;
    let createdVersions = 0;
    let createdCandidates = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const logical = this.database
        .prepare("SELECT id, authority_scope FROM logical_sessions WHERE id = ?")
        .get(input.logicalSession.id) as { readonly id: string; readonly authority_scope: string | null } | undefined;
      if (logical === undefined) {
        this.database
          .prepare(
            `INSERT INTO logical_sessions
              (id, display_title, canonical_version_id, sync_mode, archived, labels_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.logicalSession.id,
            input.logicalSession.displayTitle,
            null,
            input.logicalSession.syncMode,
            input.logicalSession.archived ? 1 : 0,
            canonicalJson([...input.logicalSession.labels]),
            input.logicalSession.createdAt,
          );
        createdLogicalSessions = 1;
      } else if (logical.authority_scope !== null) {
        advanceCanonicalSessionMetadata(this.database, {
          logicalSessionId: input.logicalSession.id,
          patch: { title: input.logicalSession.displayTitle, archived: input.logicalSession.archived },
          appliedAt: input.head.observedAt,
        });
      } else {
        this.database
          .prepare("UPDATE logical_sessions SET display_title = ?, archived = ? WHERE id = ?")
          .run(input.logicalSession.displayTitle, input.logicalSession.archived ? 1 : 0, input.logicalSession.id);
      }

      const existingBinding = this.database
        .prepare(
          `SELECT id, logical_session_id, platform, instance_id, session_id,
                  adapter_contract_json, last_common_version_id, status
           FROM platform_bindings WHERE platform = ? AND instance_id = ? AND session_id = ?`,
        )
        .get(input.binding.key.platform, input.binding.key.instanceId, input.binding.key.sessionId) as BindingRow | undefined;
      if (existingBinding === undefined) {
        this.database
          .prepare(
            `INSERT INTO platform_bindings
              (id, logical_session_id, platform, instance_id, session_id, adapter_contract_json,
               last_common_version_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.binding.id,
            input.binding.logicalSessionId,
            input.binding.key.platform,
            input.binding.key.instanceId,
            input.binding.key.sessionId,
            canonicalJson(input.binding.adapterContract as unknown as JsonValue),
            input.binding.lastCommonVersionId,
            input.binding.status,
          );
        createdBindings = 1;
      } else if (canonicalJson(bindingJson(existingBinding) as unknown as JsonValue) !== canonicalJson(input.binding as unknown as JsonValue)) {
        throw new SessionMaintenanceError("IDENTITY_CONFLICT", `Platform binding changed identity: ${input.binding.id}`);
      }

      const existingVersion = this.database
        .prepare("SELECT manifest_json FROM session_versions WHERE id = ?")
        .get(input.version.id) as ManifestRow | undefined;
      if (existingVersion === undefined) {
        this.database
          .prepare(
            `INSERT INTO session_versions
              (id, logical_session_id, body_object, body_hash, metadata_hash, manifest_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.version.id,
            input.version.logicalSessionId,
            input.version.bodyObject,
            input.version.bodyHash,
            input.version.metadataHash,
            manifestJson(input.version),
            input.version.source.observedAt,
          );
        const insertParent = this.database.prepare(
          "INSERT INTO version_parents (version_id, ordinal, parent_id) VALUES (?, ?, ?)",
        );
        input.version.parents.forEach((parent, ordinal) => insertParent.run(input.version.id, ordinal, parent));
        createdVersions = 1;
      } else {
        const stored = parseManifest(existingVersion.manifest_json, input.version.id);
        if (canonicalJson(versionIdentity(stored)) !== canonicalJson(versionIdentity(input.version))) {
          throw new SessionMaintenanceError("VERSION_ID_COLLISION", `Version ID has different content: ${input.version.id}`);
        }
      }

      if (metadata !== undefined) saveVersionMetadataSnapshot(this.database, input.version.id, metadata, "reconstructed-body");

      this.database
        .prepare(
          `INSERT INTO platform_refs (binding_id, version_id, observed_at, fingerprint_json)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(binding_id) DO UPDATE SET
             version_id = excluded.version_id,
             observed_at = excluded.observed_at,
             fingerprint_json = excluded.fingerprint_json`,
        )
        .run(
          input.head.bindingId,
          input.head.versionId,
          input.head.observedAt,
          canonicalJson(input.head.fingerprint as unknown as JsonValue),
        );

      for (const candidate of input.candidates) {
        const existing = this.database.prepare("SELECT id FROM match_candidates WHERE id = ?").get(candidate.id);
        if (existing !== undefined) continue;
        this.database
          .prepare(
            `INSERT INTO match_candidates
              (id, logical_session_id, left_binding_id, right_key_json, reason, confidence, created_at, resolved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            candidate.id,
            input.logicalSession.id,
            candidate.leftBindingId,
            canonicalJson(candidate.rightKey as unknown as JsonValue),
            candidate.reason,
            candidate.confidence,
            candidate.createdAt,
            candidate.resolvedAt ?? null,
          );
        createdCandidates += 1;
      }
      this.database.exec("COMMIT");
      return { createdLogicalSessions, createdBindings, createdVersions, createdCandidates };
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    }
  }

  async getGraph(logicalSessionId: string): Promise<VersionGraphData> {
    const versions = this.database
      .prepare("SELECT id FROM session_versions WHERE logical_session_id = ? ORDER BY id")
      .all(logicalSessionId) as unknown as VersionRow[];
    const parents = this.database
      .prepare(
        `SELECT vp.version_id, vp.parent_id
         FROM version_parents vp
         JOIN session_versions sv ON sv.id = vp.version_id
         WHERE sv.logical_session_id = ?
         ORDER BY vp.version_id, vp.ordinal`,
      )
      .all(logicalSessionId) as unknown as ParentRow[];
    const byVersion = new Map<string, string[]>();
    for (const parent of parents) {
      const list = byVersion.get(parent.version_id) ?? [];
      list.push(parent.parent_id);
      byVersion.set(parent.version_id, list);
    }
    return {
      nodes: versions.map((version) => ({
        id: version.id,
        parents: byVersion.get(version.id) ?? [],
      })),
    };
  }

  private sessionRows(logicalSessionId?: string): readonly SessionRow[] {
    const where = logicalSessionId === undefined ? "" : "WHERE ls.id = ?";
    const statement = this.database.prepare(
      `WITH ranked_workspaces AS (
         SELECT pb.logical_session_id, bw.workspace_id, bw.display_name,
                ROW_NUMBER() OVER (
                  PARTITION BY pb.logical_session_id
                  ORDER BY CASE pb.platform WHEN 'dsh' THEN 0 ELSE 1 END,
                           COALESCE(pr.observed_at, '') DESC,
                           pb.id
                ) AS workspace_rank
         FROM platform_bindings pb
         JOIN binding_workspaces bw ON bw.binding_id = pb.id
         LEFT JOIN platform_refs pr ON pr.binding_id = pb.id
       )
       SELECT ls.id, ls.display_title, ls.archived, ls.created_at,
              GROUP_CONCAT(DISTINCT pb.platform) AS platforms,
              COUNT(DISTINCT pb.id) AS binding_count,
              COUNT(DISTINCT pr.binding_id) AS head_count,
              COUNT(DISTINCT pr.version_id) AS distinct_heads,
              MAX(pr.observed_at) AS updated_at,
              rw.workspace_id,
              rw.display_name AS workspace_name
       FROM logical_sessions ls
       LEFT JOIN platform_bindings pb ON pb.logical_session_id = ls.id
       LEFT JOIN platform_refs pr ON pr.binding_id = pb.id
       LEFT JOIN ranked_workspaces rw
         ON rw.logical_session_id = ls.id AND rw.workspace_rank = 1
       ${where}
       GROUP BY ls.id
       ORDER BY COALESCE(MAX(pr.observed_at), ls.created_at) DESC, ls.id`,
    );
    return (logicalSessionId === undefined ? statement.all() : statement.all(logicalSessionId)) as unknown as SessionRow[];
  }

  async listSessions(query: SessionQuery): Promise<Page<SessionSummary>> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError(`Invalid session cursor: ${query.cursor}`);
    const summaries = this.sessionRows().map(sessionSummary);
    const filtered = summaries.filter(
      (summary) =>
        (query.platform === undefined || summary.platforms.includes(query.platform)) &&
        (query.status === undefined || summary.status === query.status) &&
        (query.workspaceId === undefined ||
          (query.workspaceId === null ? summary.workspace === null : summary.workspace?.id === query.workspaceId)),
    );
    const items = filtered.slice(offset, offset + limit);
    return {
      items,
      ...(offset + limit < filtered.length ? { nextCursor: String(offset + limit) } : {}),
    };
  }

  async listWorkspaces(): Promise<readonly WorkspaceSummary[]> {
    const groups = new Map<string, {
      workspace: WorkspaceSummary["workspace"];
      sessionCount: number;
      conflictCount: number;
      unmappedCount: number;
      platforms: Set<PlatformKind>;
      updatedAt: string;
    }>();
    for (const summary of this.sessionRows().map(sessionSummary)) {
      const key = summary.workspace?.id ?? "\u0000unclassified";
      const existing = groups.get(key) ?? {
        workspace: summary.workspace,
        sessionCount: 0,
        conflictCount: 0,
        unmappedCount: 0,
        platforms: new Set<PlatformKind>(),
        updatedAt: summary.updatedAt,
      };
      existing.sessionCount += 1;
      if (summary.status === "diverged") existing.conflictCount += 1;
      if (summary.status === "unmapped") existing.unmappedCount += 1;
      for (const platform of summary.platforms) existing.platforms.add(platform);
      if (summary.updatedAt > existing.updatedAt) existing.updatedAt = summary.updatedAt;
      groups.set(key, existing);
    }
    return [...groups.values()]
      .map((group): WorkspaceSummary => ({
        workspace: group.workspace,
        sessionCount: group.sessionCount,
        conflictCount: group.conflictCount,
        unmappedCount: group.unmappedCount,
        platforms: [...group.platforms].sort(),
        updatedAt: group.updatedAt,
      }))
      .sort((left, right) => {
        if (left.workspace === null) return 1;
        if (right.workspace === null) return -1;
        return left.workspace.name.localeCompare(right.workspace.name, "zh-CN");
      });
  }

  async getSessionSummary(logicalSessionId: string): Promise<SessionSummary | undefined> {
    const row = this.sessionRows(logicalSessionId)[0];
    return row === undefined ? undefined : sessionSummary(row);
  }

  async getGraphPage(logicalSessionId: string, cursor?: string): Promise<VersionGraphPage> {
    const limit = 50;
    const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError(`Invalid graph cursor: ${cursor}`);
    const rows = this.database
      .prepare(
        `SELECT manifest_json FROM session_versions
         WHERE logical_session_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?`,
      )
      .all(logicalSessionId, limit + 1, offset) as unknown as ManifestRow[];
    const nodes = rows.slice(0, limit).map((row) => {
      const candidate = JSON.parse(row.manifest_json) as { readonly id?: unknown };
      return parseManifest(row.manifest_json, typeof candidate.id === "string" ? candidate.id : "invalid");
    });
    const refs = this.database
      .prepare(
        `SELECT 'observed:' || pb.id AS name, pr.version_id AS version_id
         FROM platform_refs pr
         JOIN platform_bindings pb ON pb.id = pr.binding_id
         WHERE pb.logical_session_id = ?
         UNION ALL
         SELECT 'canonical' AS name, canonical_version_id AS version_id
         FROM logical_sessions
         WHERE id = ? AND canonical_version_id IS NOT NULL
         ORDER BY name`,
      )
      .all(logicalSessionId, logicalSessionId) as unknown as Array<{ readonly name: string; readonly version_id: string }>;
    return {
      nodes,
      refs: refs.map((ref) => ({ name: ref.name, versionId: ref.version_id })),
      ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
    };
  }

  async listReachableObjectIds(): Promise<readonly string[]> {
    const rows = this.database
      .prepare(
        `WITH RECURSIVE
           roots(id) AS (
             SELECT version_id FROM platform_refs
             UNION
             SELECT canonical_version_id FROM logical_sessions WHERE canonical_version_id IS NOT NULL
             UNION
             SELECT CAST(json_each.value AS TEXT)
             FROM checkpoints, json_each(checkpoints.refs_json)
           ),
           reachable(id) AS (
             SELECT id FROM roots
             UNION
             SELECT vp.parent_id
             FROM version_parents vp
             JOIN reachable r ON vp.version_id = r.id
           )
         SELECT DISTINCT sv.body_object
         FROM session_versions sv
         JOIN reachable r ON r.id = sv.id
         ORDER BY sv.body_object`,
      )
      .all() as unknown as ObjectRow[];
    const continuationRows = this.database
      .prepare("SELECT DISTINCT handoff_object_id AS body_object FROM continuation_jobs ORDER BY handoff_object_id")
      .all() as unknown as ObjectRow[];
    const evidenceRows = this.database
      .prepare("SELECT DISTINCT object_id AS body_object FROM adapter_evidence ORDER BY object_id")
      .all() as unknown as ObjectRow[];
    return [...new Set([...rows, ...continuationRows, ...evidenceRows].map((row) => row.body_object))].sort();
  }

  async savePlan(plan: SyncPlan): Promise<void> {
    syncPlanSchema.parse(plan);
    if (!verifySyncPlanIdentity(plan)) {
      throw new SessionMaintenanceError(
        "VERSION_ID_COLLISION",
        `Sync plan identity does not match its immutable content: ${plan.id}`,
      );
    }
    const serialized = canonicalJson(plan as unknown as JsonValue);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existingById = this.database
        .prepare("SELECT id, hash, plan_json FROM sync_plans WHERE id = ?")
        .get(plan.id) as PlanRow | undefined;
      if (existingById !== undefined) {
        if (existingById.hash !== plan.hash || existingById.plan_json !== serialized) {
          throw new SessionMaintenanceError(
            "VERSION_ID_COLLISION",
            `Sync plan ID has different immutable content: ${plan.id}`,
          );
        }
        this.database.exec("COMMIT");
        return;
      }

      const existingByHash = this.database
        .prepare("SELECT id, hash, plan_json FROM sync_plans WHERE hash = ?")
        .get(plan.hash) as PlanRow | undefined;
      if (existingByHash !== undefined) {
        throw new SessionMaintenanceError(
          "VERSION_ID_COLLISION",
          `Sync plan hash is already assigned to ${existingByHash.id}`,
        );
      }

      this.database
        .prepare("INSERT INTO sync_plans (id, hash, plan_json, created_at) VALUES (?, ?, ?, ?)")
        .run(plan.id, plan.hash, serialized, plan.createdAt);
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    }
  }

  async getPlan(id: string): Promise<SyncPlan | undefined> {
    const row = this.database
      .prepare("SELECT id, hash, plan_json FROM sync_plans WHERE id = ?")
      .get(id) as PlanRow | undefined;
    if (row === undefined) {
      return undefined;
    }

    try {
      const parsed: unknown = JSON.parse(row.plan_json);
      syncPlanSchema.parse(parsed);
      const plan = parsed as SyncPlan;
      if (plan.id !== row.id || plan.hash !== row.hash || !verifySyncPlanIdentity(plan)) {
        throw new Error("Stored plan identity mismatch");
      }
      return plan;
    } catch (error) {
      throw new SessionMaintenanceError("OBJECT_CORRUPT", `Stored sync plan is corrupt: ${id}`, {
        cause: error,
      });
    }
  }

  async createTransaction(input: TransactionRecord): Promise<TransactionRecord> {
    transactionRecordSchema.parse(input);
    const existingByPlan = await this.findTransactionByPlan(input.planId, input.planHash);
    if (existingByPlan !== undefined) return existingByPlan;

    const existingById = await this.getTransaction(input.id);
    if (existingById !== undefined) {
      if (canonicalJson(existingById as unknown as JsonValue) !== canonicalJson(input as unknown as JsonValue)) {
        throw new SessionMaintenanceError(
          "IDENTITY_CONFLICT",
          `Transaction ID has different content: ${input.id}`,
        );
      }
      return existingById;
    }

    this.database
      .prepare(
        `INSERT INTO transactions
          (id, plan_id, plan_hash, platform, instance_id, root_identity,
           adapter_contract_json, status, result_json, error_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.planId,
        input.planHash,
        input.platform,
        input.instanceId,
        input.rootIdentity,
        canonicalJson(input.adapterContract as unknown as JsonValue),
        input.status,
        input.result === undefined ? null : canonicalJson(input.result),
        input.errorCode ?? null,
        input.createdAt,
        input.updatedAt,
      );
    return input;
  }

  async getTransaction(id: string): Promise<TransactionRecord | undefined> {
    const row = this.database
      .prepare(
        `SELECT id, plan_id, plan_hash, platform, instance_id, root_identity,
                adapter_contract_json, status, result_json, error_code, created_at, updated_at
         FROM transactions WHERE id = ?`,
      )
      .get(id) as TransactionRow | undefined;
    if (row === undefined) return undefined;
    try {
      return transactionJson(row);
    } catch (error) {
      throw new SessionMaintenanceError("OBJECT_CORRUPT", `Stored transaction is corrupt: ${id}`, {
        cause: error,
      });
    }
  }

  async findTransactionByPlan(
    planId: string,
    planHash: string,
  ): Promise<TransactionRecord | undefined> {
    const row = this.database
      .prepare(
        `SELECT id, plan_id, plan_hash, platform, instance_id, root_identity,
                adapter_contract_json, status, result_json, error_code, created_at, updated_at
         FROM transactions WHERE plan_id = ? AND plan_hash = ?`,
      )
      .get(planId, planHash) as TransactionRow | undefined;
    return row === undefined ? undefined : transactionJson(row);
  }

  async listRecoverableTransactions(): Promise<readonly TransactionRecord[]> {
    const rows = this.database
      .prepare(
        `SELECT id, plan_id, plan_hash, platform, instance_id, root_identity,
                adapter_contract_json, status, result_json, error_code, created_at, updated_at
         FROM transactions
         WHERE status IN ('prepared', 'backing-up', 'applying', 'verifying', 'restoring')
         ORDER BY created_at, id`,
      )
      .all() as unknown as TransactionRow[];
    return rows.map(transactionJson);
  }

  async listPlans(query: PlanQuery): Promise<Page<PlanSummary>> {
    const limit = Math.min(query.limit ?? 50, 100);
    const offset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new SessionMaintenanceError("OBJECT_CORRUPT", "Invalid plan cursor");
    const rows = this.database.prepare(
      `SELECT id, hash, plan_json
       FROM sync_plans
       WHERE (? IS NULL OR json_extract(plan_json, '$.risk') = ?)
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    ).all(query.risk ?? null, query.risk ?? null, limit + 1, offset) as unknown as PlanRow[];
    const visible = rows.slice(0, limit);
    const items = visible.map((row): PlanSummary => {
      try {
        const parsed = syncPlanSchema.parse(JSON.parse(row.plan_json)) as SyncPlan;
        if (parsed.id !== row.id || parsed.hash !== row.hash || !verifySyncPlanIdentity(parsed)) throw new Error("Stored plan identity mismatch");
        return {
          id: parsed.id,
          logicalSessionId: parsed.logicalSessionId,
          createdAt: parsed.createdAt,
          risk: parsed.risk,
          operationCount: parsed.operations.length,
          confirmationCount: parsed.confirmations.length,
        };
      } catch (error) {
        throw new SessionMaintenanceError("OBJECT_CORRUPT", `Stored sync plan is corrupt: ${row.id}`, { cause: error });
      }
    });
    return { items, ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}) };
  }

  async listTransactions(query: TransactionQuery): Promise<Page<TransactionSummary>> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const offset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError(`Invalid transaction cursor: ${query.cursor}`);
    }
    const rows = this.database
      .prepare(
        `SELECT id, plan_id, plan_hash, platform, instance_id, root_identity,
                adapter_contract_json, status, result_json, error_code, created_at, updated_at
         FROM transactions
         WHERE (? IS NULL OR status = ?)
         ORDER BY updated_at DESC, id
         LIMIT ? OFFSET ?`,
      )
      .all(query.status ?? null, query.status ?? null, limit + 1, offset) as unknown as TransactionRow[];
    const items = rows.slice(0, limit).map((row): TransactionSummary => ({
      id: row.id,
      planId: row.plan_id,
      platform: row.platform,
      instanceId: row.instance_id,
      status: row.status,
      ...(row.error_code === null ? {} : { errorCode: row.error_code }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    return {
      items,
      ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
    };
  }

  async nextTransactionSequence(transactionId: string): Promise<number> {
    const transaction = await this.getTransaction(transactionId);
    if (transaction === undefined) {
      throw new SessionMaintenanceError(
        "TRANSACTION_NOT_FOUND",
        `Transaction not found: ${transactionId}`,
      );
    }
    const row = this.database
      .prepare(
        "SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM transaction_steps WHERE transaction_id = ?",
      )
      .get(transactionId) as { readonly sequence: number };
    return row.sequence;
  }

  async listTransactionSteps(transactionId: string): Promise<readonly TransactionStep[]> {
    const rows = this.database
      .prepare(
        `SELECT transaction_id, sequence, status, step, data_json, previous_hash, entry_hash, created_at
         FROM transaction_steps WHERE transaction_id = ? ORDER BY sequence`,
      )
      .all(transactionId) as unknown as TransactionStepRow[];
    return rows.map((row) =>
      transactionStepSchema.parse({
        transactionId: row.transaction_id,
        sequence: row.sequence,
        status: row.status,
        step: row.step,
        data: JSON.parse(row.data_json) as unknown,
        previousHash: row.previous_hash,
        entryHash: row.entry_hash,
        at: row.created_at,
      }) as TransactionStep,
    );
  }

  async recordTransactionStep(input: TransactionTransition): Promise<TransactionRecord> {
    transactionStepSchema.parse(input.step);
    if (input.step.transactionId === "") throw new TypeError("Transaction step requires an ID");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database
        .prepare(
          `SELECT id, plan_id, plan_hash, platform, instance_id, root_identity,
                  adapter_contract_json, status, result_json, error_code, created_at, updated_at
           FROM transactions WHERE id = ?`,
        )
        .get(input.step.transactionId) as TransactionRow | undefined;
      if (current === undefined) {
        throw new SessionMaintenanceError(
          "TRANSACTION_NOT_FOUND",
          `Transaction not found: ${input.step.transactionId}`,
        );
      }
      const last = this.database
        .prepare(
          `SELECT sequence, entry_hash FROM transaction_steps
           WHERE transaction_id = ? ORDER BY sequence DESC LIMIT 1`,
        )
        .get(input.step.transactionId) as
        | { readonly sequence: number; readonly entry_hash: string }
        | undefined;
      const expectedSequence = (last?.sequence ?? -1) + 1;
      const expectedPrevious = last?.entry_hash ?? null;
      if (
        input.step.sequence !== expectedSequence ||
        input.step.previousHash !== expectedPrevious
      ) {
        throw new SessionMaintenanceError(
          "OBJECT_CORRUPT",
          `Transaction journal/database sequence mismatch: ${input.step.transactionId}`,
        );
      }
      this.database
        .prepare(
          `INSERT INTO transaction_steps
            (transaction_id, sequence, status, step, data_json, previous_hash, entry_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.step.transactionId,
          input.step.sequence,
          input.step.status,
          input.step.step,
          canonicalJson(input.step.data),
          input.step.previousHash,
          input.step.entryHash,
          input.step.at,
        );
      this.database
        .prepare(
          `UPDATE transactions
           SET status = ?, result_json = COALESCE(?, result_json),
               error_code = COALESCE(?, error_code), updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.step.status,
          input.result === undefined ? null : canonicalJson(input.result),
          input.errorCode ?? null,
          input.step.at,
          input.step.transactionId,
        );
      this.database.exec("COMMIT");
      return {
        ...transactionJson(current),
        status: input.step.status,
        ...(input.result === undefined ? {} : { result: input.result }),
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        updatedAt: input.step.at,
      };
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original transition failure.
      }
      throw error;
    }
  }

  async markTransactionManualReview(
    transactionId: string,
    updatedAt: string,
    errorCode: string,
  ): Promise<TransactionRecord> {
    const result = this.database
      .prepare(
        `UPDATE transactions
         SET status = 'manual-review', error_code = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(errorCode, updatedAt, transactionId);
    if (Number(result.changes) !== 1) {
      throw new SessionMaintenanceError(
        "TRANSACTION_NOT_FOUND",
        `Transaction not found: ${transactionId}`,
      );
    }
    return (await this.getTransaction(transactionId))!;
  }

  async saveBackupManifest(manifest: BackupManifest): Promise<void> {
    backupManifestSchema.parse(manifest);
    const serialized = canonicalJson(manifest as unknown as JsonValue);
    const existing = this.database
      .prepare("SELECT manifest_hash, manifest_json FROM backup_manifests WHERE transaction_id = ?")
      .get(manifest.transactionId) as BackupManifestRow | undefined;
    if (existing !== undefined) {
      if (existing.manifest_hash !== manifest.hash || existing.manifest_json !== serialized) {
        throw new SessionMaintenanceError(
          "BACKUP_CORRUPT",
          `Backup manifest changed for transaction: ${manifest.transactionId}`,
        );
      }
      return;
    }
    this.database
      .prepare(
        `INSERT INTO backup_manifests (transaction_id, manifest_hash, manifest_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(manifest.transactionId, manifest.hash, serialized, manifest.createdAt);
  }

  async getBackupManifest(transactionId: string): Promise<BackupManifest | undefined> {
    const row = this.database
      .prepare("SELECT manifest_hash, manifest_json FROM backup_manifests WHERE transaction_id = ?")
      .get(transactionId) as BackupManifestRow | undefined;
    if (row === undefined) return undefined;
    try {
      const parsed = backupManifestSchema.parse(JSON.parse(row.manifest_json) as unknown) as BackupManifest;
      if (parsed.hash !== row.manifest_hash || parsed.transactionId !== transactionId) {
        throw new Error("Backup manifest identity mismatch");
      }
      return parsed;
    } catch (error) {
      throw new SessionMaintenanceError(
        "BACKUP_CORRUPT",
        `Stored backup manifest is corrupt: ${transactionId}`,
        { cause: error },
      );
    }
  }

  async listBackupProtections(): Promise<readonly BackupProtection[]> {
    const rows = this.database
      .prepare(
        `SELECT t.id AS transaction_id,
                CASE WHEN ct.transaction_id IS NULL THEN 0 ELSE 1 END AS checkpoint_protected,
                CASE WHEN t.status IN ('completed', 'restored') THEN 0 ELSE 1 END AS unresolved
         FROM transactions t
         LEFT JOIN (
           SELECT DISTINCT transaction_id FROM checkpoint_transactions
         ) ct ON ct.transaction_id = t.id
         WHERE ct.transaction_id IS NOT NULL
            OR t.status NOT IN ('completed', 'restored')
         ORDER BY t.id`,
      )
      .all() as unknown as Array<{
        readonly transaction_id: string;
        readonly checkpoint_protected: number;
        readonly unresolved: number;
      }>;
    return rows.map((row) => ({
      transactionId: row.transaction_id,
      reasons: [
        ...(row.checkpoint_protected === 1 ? (["checkpoint"] as const) : []),
        ...(row.unresolved === 1 ? (["unresolved-transaction"] as const) : []),
      ],
    }));
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    checkpointSchema.parse(checkpoint);
    const existing = await this.getCheckpoint(checkpoint.id);
    if (existing !== undefined) {
      if (canonicalJson(existing as unknown as JsonValue) !== canonicalJson(checkpoint as unknown as JsonValue)) {
        throw new SessionMaintenanceError(
          "IDENTITY_CONFLICT",
          `Checkpoint ID has different content: ${checkpoint.id}`,
        );
      }
      return;
    }
    for (const transactionId of checkpoint.backupTransactionIds) {
      const transaction = await this.getTransaction(transactionId);
      const backup = await this.getBackupManifest(transactionId);
      if (
        transaction === undefined ||
        !["completed", "restored"].includes(transaction.status) ||
        backup === undefined
      ) {
        throw new SessionMaintenanceError(
          "BACKUP_INCOMPLETE",
          `Checkpoint references an unusable transaction backup: ${transactionId}`,
        );
      }
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO checkpoints
            (id, name, description, refs_json, backup_transaction_ids_json, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          checkpoint.id,
          checkpoint.name,
          checkpoint.description,
          canonicalJson(checkpoint.refs as unknown as JsonValue),
          canonicalJson([...checkpoint.backupTransactionIds]),
          checkpoint.createdBy,
          checkpoint.createdAt,
        );
      const insert = this.database.prepare(
        "INSERT INTO checkpoint_transactions (checkpoint_id, transaction_id) VALUES (?, ?)",
      );
      for (const transactionId of checkpoint.backupTransactionIds) {
        insert.run(checkpoint.id, transactionId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the checkpoint failure.
      }
      throw error;
    }
  }

  async getCheckpoint(id: string): Promise<Checkpoint | undefined> {
    const row = this.database
      .prepare(
        `SELECT id, name, description, refs_json, backup_transaction_ids_json, created_by, created_at
         FROM checkpoints WHERE id = ?`,
      )
      .get(id) as CheckpointRow | undefined;
    return row === undefined ? undefined : checkpointJson(row);
  }

  async listCheckpoints(): Promise<readonly Checkpoint[]> {
    const rows = this.database
      .prepare(
        `SELECT id, name, description, refs_json, backup_transaction_ids_json, created_by, created_at
         FROM checkpoints ORDER BY created_at, id`,
      )
      .all() as unknown as CheckpointRow[];
    return rows.map(checkpointJson);
  }

  async saveConfirmation(input: StoredConfirmation): Promise<void> {
    storedConfirmationSchema.parse(input);
    this.database
      .prepare(
        `INSERT INTO confirmation_nonces
          (token_hash, operation, resource_id, operation_hash, expires_at, created_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tokenHash,
        input.operation,
        input.resourceId,
        input.operationHash,
        input.expiresAt,
        input.createdAt,
        input.consumedAt,
      );
  }

  async getConfirmation(tokenHash: string): Promise<StoredConfirmation | undefined> {
    const row = this.database
      .prepare(
        `SELECT token_hash, operation, resource_id, operation_hash, expires_at, created_at, consumed_at
         FROM confirmation_nonces WHERE token_hash = ?`,
      )
      .get(tokenHash) as ConfirmationRow | undefined;
    return row === undefined ? undefined : confirmationJson(row);
  }

  async consumeConfirmation(tokenHash: string, consumedAt: string): Promise<boolean> {
    const result = this.database
      .prepare(
        `UPDATE confirmation_nonces SET consumed_at = ?
         WHERE token_hash = ? AND consumed_at IS NULL`,
      )
      .run(consumedAt, tokenHash);
    return Number(result.changes) === 1;
  }

  async createContinuationJob(input: ContinuationJob): Promise<ContinuationJob> {
    continuationJobSchema.parse(input);
    const byHash = await this.findContinuationByRequestHash(input.requestHash);
    if (byHash !== undefined) return byHash;
    const byId = await this.getContinuationJob(input.id);
    if (byId !== undefined) {
      if (canonicalJson(byId as unknown as JsonValue) !== canonicalJson(input as unknown as JsonValue)) {
        throw new SessionMaintenanceError(
          "IDENTITY_CONFLICT",
          `Continuation job ID has different content: ${input.id}`,
        );
      }
      return byId;
    }
    this.database
      .prepare(
        `INSERT INTO continuation_jobs
          (id, request_hash, request_json, logical_session_id, source_version_ids_json,
           target_preset_id, mode, handoff_object_id, status, codex_thread_id,
           codex_turn_id, error_code, verification_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.requestHash,
        canonicalJson(input.request as unknown as JsonValue),
        input.logicalSessionId,
        canonicalJson([...input.sourceVersionIds]),
        input.targetPresetId,
        input.mode,
        input.handoffObjectId,
        input.status,
        input.codexThreadId ?? null,
        input.codexTurnId ?? null,
        input.errorCode ?? null,
        input.verification === undefined ? null : canonicalJson(input.verification),
        input.createdAt,
        input.updatedAt,
      );
    return input;
  }

  async getContinuationJob(id: string): Promise<ContinuationJob | undefined> {
    const row = this.database
      .prepare(
        `SELECT id, request_hash, request_json, logical_session_id, source_version_ids_json,
                target_preset_id, mode, handoff_object_id, status, codex_thread_id,
                codex_turn_id, error_code, verification_json, created_at, updated_at
         FROM continuation_jobs WHERE id = ?`,
      )
      .get(id) as ContinuationJobRow | undefined;
    if (row === undefined) return undefined;
    try {
      return continuationJobJson(row);
    } catch (error) {
      throw new SessionMaintenanceError("OBJECT_CORRUPT", `Stored continuation job is corrupt: ${id}`, {
        cause: error,
      });
    }
  }

  async findContinuationByRequestHash(requestHash: string): Promise<ContinuationJob | undefined> {
    const row = this.database
      .prepare(
        `SELECT id, request_hash, request_json, logical_session_id, source_version_ids_json,
                target_preset_id, mode, handoff_object_id, status, codex_thread_id,
                codex_turn_id, error_code, verification_json, created_at, updated_at
         FROM continuation_jobs WHERE request_hash = ?`,
      )
      .get(requestHash) as ContinuationJobRow | undefined;
    return row === undefined ? undefined : continuationJobJson(row);
  }

  async transitionContinuationJob(
    id: string,
    transition: ContinuationTransition,
  ): Promise<ContinuationJob> {
    continuationTransitionSchema.parse(transition);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = await this.getContinuationJob(id);
      if (current === undefined) {
        throw new SessionMaintenanceError("CONTINUATION_NOT_FOUND", `Continuation job not found: ${id}`);
      }
      if (!transition.expected.includes(current.status)) {
        if (current.status === transition.status) {
          this.database.exec("COMMIT");
          return current;
        }
        throw new SessionMaintenanceError(
          "CONTINUATION_RECOVERY_REQUIRED",
          `Continuation ${id} is ${current.status}; expected ${transition.expected.join(", ")}`,
        );
      }
      this.database
        .prepare(
          `UPDATE continuation_jobs
           SET status = ?,
               codex_thread_id = COALESCE(?, codex_thread_id),
               codex_turn_id = COALESCE(?, codex_turn_id),
               error_code = ?,
               verification_json = COALESCE(?, verification_json),
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          transition.status,
          transition.codexThreadId ?? null,
          transition.codexTurnId ?? null,
          transition.errorCode ?? null,
          transition.verification === undefined ? null : canonicalJson(transition.verification),
          transition.updatedAt,
          id,
        );
      this.database.exec("COMMIT");
      return (await this.getContinuationJob(id))!;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the transition failure.
      }
      throw error;
    }
  }

  async listRecoverableContinuations(): Promise<readonly ContinuationJob[]> {
    const rows = this.database
      .prepare(
        `SELECT id, request_hash, request_json, logical_session_id, source_version_ids_json,
                target_preset_id, mode, handoff_object_id, status, codex_thread_id,
                codex_turn_id, error_code, verification_json, created_at, updated_at
         FROM continuation_jobs
         WHERE status IN ('creating', 'started', 'verifying', 'manual-review')
         ORDER BY created_at, id`,
      )
      .all() as unknown as ContinuationJobRow[];
    return rows.map(continuationJobJson);
  }

  close(): void {
    this.database.close();
  }
}
