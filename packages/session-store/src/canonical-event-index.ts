import type { DatabaseSync } from "node:sqlite";

import type { CanonicalEventV1, JsonValue, LogicalSessionId } from "@linmu/dsh-session-contracts";
import { canonicalJson } from "@linmu/dsh-session-domain";

interface EventIndexRow {
  readonly id: string;
  readonly sequence: number;
  readonly kind: string;
  readonly content_digest: string;
  readonly event_json: string;
}

/** Called within the version/head transaction. Historical bodies remain immutable. */
export function updateCanonicalEventIndex(database: DatabaseSync, logicalSessionId: LogicalSessionId, events: readonly CanonicalEventV1[]): void {
  const owned = events.filter((event) => event.logicalSessionId === logicalSessionId);
  const existing = database.prepare(
    `SELECT id, sequence, kind, content_digest, event_json FROM canonical_events
     WHERE logical_session_id = ? ORDER BY sequence`,
  ).all(logicalSessionId) as unknown as EventIndexRow[];
  // Checking the complete JSON also detects changes in source evidence or
  // topology extensions whose contentDigest legitimately stays unchanged.
  let prefixMatches = existing.length <= owned.length;
  for (let index = 0; prefixMatches && index < existing.length; index++) {
    const row = existing[index]!;
    const event = owned[index]!;
    prefixMatches = row.id === event.id && row.sequence === event.sequence &&
      row.kind === event.kind && row.content_digest === event.contentDigest &&
      row.event_json === canonicalJson(event as unknown as JsonValue);
  }
  if (!prefixMatches) database.prepare("DELETE FROM canonical_events WHERE logical_session_id = ?").run(logicalSessionId);
  const insert = database.prepare(
    `INSERT INTO canonical_events (id, logical_session_id, sequence, kind, content_digest, event_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (let index = prefixMatches ? existing.length : 0; index < owned.length; index++) {
    const event = owned[index]!;
    insert.run(event.id, logicalSessionId, event.sequence, event.kind, event.contentDigest, canonicalJson(event as unknown as JsonValue));
  }
}
