import type { DatabaseSync } from "node:sqlite";

import {
  projectionOperationReceiptSchema,
  projectionRunSchema,
  projectionSessionSchema,
  type JsonValue,
  type OperationId,
  type ProjectionOperationReceipt,
  type ProjectionRun,
  type ProjectionRunRepository,
  type ProjectionRunState,
  type ProjectionSession,
  type RunId,
} from "@linmu/dsh-session-contracts";
import { canonicalJson } from "@linmu/dsh-session-domain";

interface RunRow {
  readonly id: string;
  readonly lease_id: string;
  readonly branch_id: string;
  readonly instance_id: string;
  readonly profile_id: string;
  readonly dsh_version: string;
  readonly adapter_id: string;
  readonly state: ProjectionRunState;
  readonly started_at: string;
  readonly heartbeat_at: string;
  readonly checkpoint_id: string | null;
}

interface ReceiptRow {
  readonly receipt_json: string;
}

interface ProjectionSessionRow {
  readonly run_id: string;
  readonly native_session_id: string;
  readonly logical_session_id: string;
  readonly base_version_id: string | null;
  readonly mode: ProjectionSession["mode"];
  readonly native_revision: number;
  readonly last_committed_operation_id: string | null;
  readonly derived_child_session_id: string | null;
}

function runFromRow(row: RunRow): ProjectionRun {
  return projectionRunSchema.parse({
    schemaVersion: 1,
    id: row.id,
    leaseId: row.lease_id,
    branchId: row.branch_id,
    instanceId: row.instance_id,
    profileId: row.profile_id,
    dshVersion: row.dsh_version,
    adapterId: row.adapter_id,
    state: row.state,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    checkpointId: row.checkpoint_id,
  }) as unknown as ProjectionRun;
}

function stableJson(value: unknown): string {
  return canonicalJson(value as JsonValue);
}

export class SqliteProjectionRunRepository implements ProjectionRunRepository {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async createProjectionRun(input: ProjectionRun): Promise<ProjectionRun> {
    projectionRunSchema.parse(input);
    const existing = await this.getProjectionRun(input.id);
    if (existing !== undefined) {
      if (stableJson(existing) !== stableJson(input)) {
        throw new Error(`Projection run ID already has different content: ${input.id}`);
      }
      return existing;
    }
    this.database
      .prepare(
        `INSERT INTO projection_runs
          (id, lease_id, branch_id, instance_id, profile_id, dsh_version, adapter_id,
           state, started_at, heartbeat_at, checkpoint_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.leaseId,
        input.branchId,
        input.instanceId,
        input.profileId,
        input.dshVersion,
        input.adapterId,
        input.state,
        input.startedAt,
        input.heartbeatAt,
        input.checkpointId,
      );
    return input;
  }

  async getProjectionRun(id: RunId): Promise<ProjectionRun | undefined> {
    const row = this.database
      .prepare(
        `SELECT id, lease_id, branch_id, instance_id, profile_id, dsh_version,
                adapter_id, state, started_at, heartbeat_at, checkpoint_id
         FROM projection_runs WHERE id = ?`,
      )
      .get(id) as RunRow | undefined;
    return row === undefined ? undefined : runFromRow(row);
  }

  async setProjectionRunState(id: RunId, state: ProjectionRunState): Promise<void> {
    const result = this.database
      .prepare("UPDATE projection_runs SET state = ? WHERE id = ?")
      .run(state, id);
    if (Number(result.changes) !== 1) {
      throw new Error(`Projection run not found: ${id}`);
    }
  }

  async setProjectionRunCheckpoint(id: RunId, checkpointId: string): Promise<void> {
    const result = this.database.prepare("UPDATE projection_runs SET checkpoint_id = ? WHERE id = ?").run(checkpointId, id);
    if (Number(result.changes) !== 1) throw new Error(`Projection run not found: ${id}`);
  }

  async listProjectionSessions(runId: RunId): Promise<readonly ProjectionSession[]> {
    const rows = this.database.prepare(
      `SELECT run_id, native_session_id, logical_session_id, base_version_id, mode,
              native_revision, last_committed_operation_id, derived_child_session_id
       FROM projection_sessions WHERE run_id = ? ORDER BY native_session_id`,
    ).all(runId) as unknown as ProjectionSessionRow[];
    return rows.map((row) => projectionSessionSchema.parse({
      schemaVersion: 1,
      runId: row.run_id,
      nativeSessionId: row.native_session_id,
      logicalSessionId: row.logical_session_id,
      baseVersionId: row.base_version_id,
      mode: row.mode,
      nativeRevision: row.native_revision,
      lastCommittedOperationId: row.last_committed_operation_id,
      derivedChildSessionId: row.derived_child_session_id,
    }) as unknown as ProjectionSession);
  }

  async upsertProjectionSession(input: ProjectionSession): Promise<void> {
    projectionSessionSchema.parse(input);
    const result = this.database
      .prepare(
        `INSERT INTO projection_sessions
          (run_id, native_session_id, logical_session_id, base_version_id, mode,
           native_revision, last_committed_operation_id, derived_child_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, native_session_id) DO UPDATE SET
           logical_session_id = excluded.logical_session_id,
           base_version_id = excluded.base_version_id,
           mode = excluded.mode,
           native_revision = excluded.native_revision,
           last_committed_operation_id = excluded.last_committed_operation_id,
           derived_child_session_id = excluded.derived_child_session_id
         WHERE excluded.native_revision >= projection_sessions.native_revision`,
      )
      .run(
        input.runId,
        input.nativeSessionId,
        input.logicalSessionId,
        input.baseVersionId,
        input.mode,
        input.nativeRevision,
        input.lastCommittedOperationId,
        input.derivedChildSessionId,
      );
    if (Number(result.changes) === 0) {
      throw new Error(`Projection session revision moved backwards: ${input.nativeSessionId}`);
    }
  }

  async saveOperationReceipt(input: ProjectionOperationReceipt): Promise<void> {
    projectionOperationReceiptSchema.parse(input);
    const serialized = stableJson(input);
    const existing = this.database
      .prepare("SELECT receipt_json FROM run_operations WHERE operation_id = ?")
      .get(input.operationId) as ReceiptRow | undefined;
    if (existing !== undefined) {
      if (existing.receipt_json !== serialized) {
        throw new Error(`Operation ID already has a different receipt: ${input.operationId}`);
      }
      return;
    }
    this.database
      .prepare(
        `INSERT INTO run_operations
          (operation_id, run_id, logical_session_id, native_session_id, status,
           canonical_version_id, projection_revision, committed_at, receipt_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.operationId,
        input.runId,
        input.logicalSessionId,
        input.nativeSessionId,
        input.status,
        input.canonicalVersionId,
        input.projectionRevision,
        input.committedAt,
        serialized,
      );
  }

  async getOperationReceipt(
    operationId: OperationId,
  ): Promise<ProjectionOperationReceipt | undefined> {
    const row = this.database
      .prepare("SELECT receipt_json FROM run_operations WHERE operation_id = ?")
      .get(operationId) as ReceiptRow | undefined;
    return row === undefined
      ? undefined
      : projectionOperationReceiptSchema.parse(
          JSON.parse(row.receipt_json),
        ) as unknown as ProjectionOperationReceipt;
  }
}
