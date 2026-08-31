import type { DatabaseSync } from "node:sqlite";

import type {
  LogicalSessionId,
  LogicalWorkspaceId,
  StableLogicalReference,
  StableLogicalReferenceResolution,
} from "@linmu/dsh-session-contracts";

export type SessionAliasKind = "dsh-session" | "dsh-workspace" | "legacy-reference";

export type SessionAliasTarget =
  | {
      readonly logicalSessionId: LogicalSessionId;
      readonly logicalWorkspaceId: null;
    }
  | {
      readonly logicalSessionId: null;
      readonly logicalWorkspaceId: LogicalWorkspaceId;
    };

export interface SessionAliasRecord {
  readonly aliasKind: SessionAliasKind;
  readonly instanceId: string;
  readonly nativeId: string;
  readonly target: SessionAliasTarget;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}

interface AliasRow {
  readonly alias_kind: SessionAliasKind;
  readonly instance_id: string;
  readonly native_id: string;
  readonly logical_session_id: string | null;
  readonly logical_workspace_id: string | null;
  readonly created_at: string;
  readonly last_seen_at: string;
}

interface ActiveProjectionRow {
  readonly run_id: string;
  readonly logical_session_id: string;
  readonly native_session_id: string;
}

function aliasFromRow(row: AliasRow): SessionAliasRecord {
  if ((row.logical_session_id === null) === (row.logical_workspace_id === null)) {
    throw new Error(`Stored session alias has an invalid target: ${row.native_id}`);
  }
  return {
    aliasKind: row.alias_kind,
    instanceId: row.instance_id,
    nativeId: row.native_id,
    target: row.logical_session_id === null
      ? {
          logicalSessionId: null,
          logicalWorkspaceId: row.logical_workspace_id as LogicalWorkspaceId,
        }
      : {
          logicalSessionId: row.logical_session_id as LogicalSessionId,
          logicalWorkspaceId: null,
        },
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export class SqliteSessionAliasRepository {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async upsert(input: SessionAliasRecord): Promise<void> {
    if (input.instanceId.length === 0 || input.nativeId.length === 0) {
      throw new TypeError("Session aliases require non-empty instance and native IDs");
    }
    this.database
      .prepare(
        `INSERT INTO session_aliases
          (alias_kind, instance_id, native_id, logical_session_id, logical_workspace_id,
           created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(alias_kind, instance_id, native_id) DO UPDATE SET
           logical_session_id = excluded.logical_session_id,
           logical_workspace_id = excluded.logical_workspace_id,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        input.aliasKind,
        input.instanceId,
        input.nativeId,
        input.target.logicalSessionId,
        input.target.logicalWorkspaceId,
        input.createdAt,
        input.lastSeenAt,
      );
  }

  async resolve(
    aliasKind: SessionAliasKind,
    instanceId: string,
    nativeId: string,
  ): Promise<SessionAliasRecord | undefined> {
    const row = this.database
      .prepare(
        `SELECT alias_kind, instance_id, native_id, logical_session_id,
                logical_workspace_id, created_at, last_seen_at
         FROM session_aliases
         WHERE alias_kind = ? AND instance_id = ? AND native_id = ?`,
      )
      .get(aliasKind, instanceId, nativeId) as AliasRow | undefined;
    return row === undefined ? undefined : aliasFromRow(row);
  }

  async resolveStableReference(
    input: StableLogicalReference,
    instanceId?: string,
  ): Promise<StableLogicalReferenceResolution> {
    let logicalSessionId = input.logicalSessionId;
    if (logicalSessionId === null && input.legacyNativeSessionId !== null) {
      const alias = instanceId === undefined
        ? this.database.prepare(
            `SELECT alias_kind, instance_id, native_id, logical_session_id,
                    logical_workspace_id, created_at, last_seen_at
             FROM session_aliases
             WHERE alias_kind = 'legacy-reference' AND native_id = ?
             ORDER BY last_seen_at DESC, instance_id ASC LIMIT 1`,
          ).get(input.legacyNativeSessionId) as AliasRow | undefined
        : undefined;
      const resolvedAlias = alias === undefined
        ? instanceId === undefined ? undefined : await this.resolve("legacy-reference", instanceId, input.legacyNativeSessionId)
        : aliasFromRow(alias);
      logicalSessionId = resolvedAlias?.target.logicalSessionId ?? null;
      if (logicalSessionId === null) {
        const activeLegacy = this.database.prepare(
          `SELECT ps.run_id, ps.logical_session_id, ps.native_session_id
           FROM projection_sessions ps
           JOIN projection_runs pr ON pr.id = ps.run_id
           WHERE ps.native_session_id = ? AND pr.state IN ('preparing', 'running', 'draining', 'verifying')
           ORDER BY pr.heartbeat_at DESC, pr.id DESC LIMIT 1`,
        ).get(input.legacyNativeSessionId) as ActiveProjectionRow | undefined;
        logicalSessionId = activeLegacy?.logical_session_id as LogicalSessionId | undefined ?? null;
      }
    }
    if (logicalSessionId === null) {
      return {
        referenceType: input.referenceType,
        logicalSessionId: null,
        logicalAnchorId: input.logicalAnchorId,
        nativeSessionId: null,
        nativeAnchorId: null,
        runId: null,
        status: "unavailable",
      };
    }
    const active = this.database.prepare(
      `SELECT ps.run_id, ps.logical_session_id, ps.native_session_id
       FROM projection_sessions ps
       JOIN projection_runs pr ON pr.id = ps.run_id
       WHERE ps.logical_session_id = ? AND pr.state IN ('preparing', 'running', 'draining', 'verifying')
       ORDER BY pr.heartbeat_at DESC, pr.id DESC LIMIT 1`,
    ).get(logicalSessionId) as ActiveProjectionRow | undefined;
    return {
      referenceType: input.referenceType,
      logicalSessionId,
      logicalAnchorId: input.logicalAnchorId,
      nativeSessionId: (active?.native_session_id as StableLogicalReferenceResolution["nativeSessionId"] | undefined) ?? null,
      nativeAnchorId: active === undefined
        ? null
        : input.logicalAnchorId ?? input.legacyNativeAnchorId,
      runId: (active?.run_id as StableLogicalReferenceResolution["runId"] | undefined) ?? null,
      status: active === undefined ? "unavailable" : "resolved",
    };
  }
}
