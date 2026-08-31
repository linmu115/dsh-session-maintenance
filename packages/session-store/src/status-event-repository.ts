import type { DatabaseSync } from "node:sqlite";

import {
  statusEventQuerySchema,
  statusEventV1Schema,
  type JsonValue,
  type Page,
  type StatusEventQuery,
  type StatusEventRepository,
  type StatusEventV1,
} from "@linmu/dsh-session-contracts";
import { canonicalJson } from "@linmu/dsh-session-domain";

interface EventRow {
  readonly event_json: string;
}

interface SequenceRow {
  readonly sequence: number;
}

export class SqliteStatusEventRepository implements StatusEventRepository {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async appendStatusEvent(input: StatusEventV1): Promise<void> {
    statusEventV1Schema.parse(input);
    const serialized = canonicalJson(input as unknown as JsonValue);
    const existing = this.database
      .prepare("SELECT event_json FROM run_status_events WHERE id = ?")
      .get(input.id) as EventRow | undefined;
    if (existing !== undefined) {
      if (existing.event_json !== serialized) {
        throw new Error(`Status event ID already has different content: ${input.id}`);
      }
      return;
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare(
          `SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
           FROM run_status_events WHERE run_id = ?`,
        )
        .get(input.runId) as unknown as SequenceRow;
      this.database
        .prepare(
          `INSERT INTO run_status_events
            (id, run_id, sequence, at, lease_id, profile_id, adapter_id, dsh_version,
             stage, state, logical_session_id, native_session_id, operation_id,
             parent_event_id, span_id, error_code, duration_ms, diagnostic_detail_ref,
             event_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.runId,
          row.sequence,
          input.at,
          input.leaseId,
          input.profileId,
          input.adapterId,
          input.dshVersion,
          input.stage,
          input.state,
          input.logicalSessionId,
          input.nativeSessionId,
          input.operationId,
          input.parentEventId,
          input.spanId,
          input.errorCode,
          input.durationMs,
          input.diagnosticDetailRef,
          serialized,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original status append failure.
      }
      throw error;
    }
  }

  async listStatusEvents(query: StatusEventQuery): Promise<Page<StatusEventV1>> {
    statusEventQuerySchema.parse(query);
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError(`Invalid status event cursor: ${query.cursor}`);
    }
    const limit = query.limit ?? 50;
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    const add = (column: string, value: string | undefined): void => {
      if (value !== undefined) {
        clauses.push(`${column} = ?`);
        values.push(value);
      }
    };
    add("run_id", query.runId);
    add("logical_session_id", query.logicalSessionId);
    add("operation_id", query.operationId);
    add("stage", query.stage);
    add("span_id", query.spanId);
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const rows = this.database
      .prepare(
        `SELECT event_json FROM run_status_events
         ${where}
         ORDER BY at, id
         LIMIT ? OFFSET ?`,
      )
      .all(...values, limit + 1, offset) as unknown as EventRow[];
    const items = rows.slice(0, limit).map((row) =>
      statusEventV1Schema.parse(JSON.parse(row.event_json)) as unknown as StatusEventV1
    );
    return {
      items,
      ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
    };
  }
}
