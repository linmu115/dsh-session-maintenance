import type { DatabaseSync } from "node:sqlite";

import {
  nativeSessionReferenceIndexV1Schema,
  type AdapterId,
  type LogicalSessionId,
  type NativeSessionId,
  type NativeSessionReferenceIndexV1,
  type NativeSessionReferenceRepository,
  type NativeSessionReferenceV1,
  type RunId,
} from "@linmu/dsh-session-contracts";

interface SourceRow {
  readonly instance_id: string;
  readonly session_id: string;
  readonly platform: "codex" | "dsh";
  readonly adapter_contract_json: string;
}

interface ProjectionRow {
  readonly instance_id: string;
  readonly native_session_id: string;
  readonly adapter_id: string;
  readonly run_id: string;
}

interface AliasRow {
  readonly instance_id: string;
  readonly native_id: string;
}

function sourceAdapterId(serialized: string): AdapterId | null {
  try {
    const value = JSON.parse(serialized) as { readonly adapter?: unknown };
    return typeof value.adapter === "string" && value.adapter.length > 0
      ? value.adapter as AdapterId
      : null;
  } catch {
    return null;
  }
}

const useOrder: Readonly<Record<NativeSessionReferenceV1["referenceUse"], number>> = {
  source: 0,
  "active-projection": 1,
  "historical-alias": 2,
};

function key(reference: NativeSessionReferenceV1): string {
  return [
    reference.referenceUse,
    reference.platform,
    reference.instanceId,
    reference.nativeSessionId,
    reference.runId ?? "",
  ].join("\0");
}

export class SqliteNativeSessionReferenceRepository implements NativeSessionReferenceRepository {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async getReferenceIndex(logicalSessionId: LogicalSessionId): Promise<NativeSessionReferenceIndexV1 | undefined> {
    const exists = this.database.prepare(
      "SELECT 1 AS present FROM logical_sessions WHERE id = ? AND authority_scope IS NOT NULL",
    ).get(logicalSessionId) as { readonly present: number } | undefined;
    if (exists === undefined) return undefined;

    const sources = this.database.prepare(
      `SELECT instance_id, session_id, platform, adapter_contract_json
       FROM platform_bindings
       WHERE logical_session_id = ?
       ORDER BY platform, instance_id, session_id`,
    ).all(logicalSessionId) as unknown as SourceRow[];
    const projections = this.database.prepare(
      `SELECT pr.instance_id, ps.native_session_id, pr.adapter_id, pr.id AS run_id
       FROM projection_sessions ps
       JOIN projection_runs pr ON pr.id = ps.run_id
       WHERE ps.logical_session_id = ?
         AND pr.state IN ('preparing', 'running', 'draining', 'verifying')
       ORDER BY pr.heartbeat_at DESC, pr.id, ps.native_session_id`,
    ).all(logicalSessionId) as unknown as ProjectionRow[];
    const aliases = this.database.prepare(
      `SELECT instance_id, native_id
       FROM session_aliases
       WHERE logical_session_id = ? AND alias_kind IN ('dsh-session', 'legacy-reference')
       ORDER BY last_seen_at DESC, instance_id, native_id`,
    ).all(logicalSessionId) as unknown as AliasRow[];

    const references: NativeSessionReferenceV1[] = [
      ...sources.map((row) => ({
        schemaVersion: 1 as const,
        logicalSessionId,
        platform: row.platform,
        instanceId: row.instance_id,
        nativeSessionId: row.session_id as NativeSessionId,
        adapterId: sourceAdapterId(row.adapter_contract_json),
        referenceUse: "source" as const,
        runId: null,
      })),
      ...projections.map((row) => ({
        schemaVersion: 1 as const,
        logicalSessionId,
        platform: "dsh" as const,
        instanceId: row.instance_id,
        nativeSessionId: row.native_session_id as NativeSessionId,
        adapterId: row.adapter_id as AdapterId,
        referenceUse: "active-projection" as const,
        runId: row.run_id as RunId,
      })),
      ...aliases.map((row) => ({
        schemaVersion: 1 as const,
        logicalSessionId,
        platform: "dsh" as const,
        instanceId: row.instance_id,
        nativeSessionId: row.native_id as NativeSessionId,
        adapterId: null,
        referenceUse: "historical-alias" as const,
        runId: null,
      })),
    ];
    const unique = [...new Map(references.map((reference) => [key(reference), reference])).values()]
      .sort((left, right) => useOrder[left.referenceUse] - useOrder[right.referenceUse]);
    return nativeSessionReferenceIndexV1Schema.parse({
      schemaVersion: 1,
      logicalSessionId,
      references: unique,
    }) as unknown as NativeSessionReferenceIndexV1;
  }
}
