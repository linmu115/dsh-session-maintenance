import { stat } from "node:fs/promises";

import {
  SessionMaintenanceError,
  type PlatformSessionSummary,
  type RegisteredInstance,
  type ScanCursor,
} from "@linmu/dsh-session-contracts";

import type { CodexThreadRow } from "./parser.js";
import { openCodexDatabase, resolveContainedRollout } from "./stable-read.js";
import { codexWorkspaceId, codexWorkspaceLabel } from "./workspace.js";

export async function* listCodexSessions(
  instance: RegisteredInstance,
  cursor: ScanCursor | undefined,
  fixtureGuard?: (root: string) => void,
): AsyncIterable<PlatformSessionSummary> {
  fixtureGuard?.(instance.root);
  if (instance.platform !== "codex" || instance.platformVersion !== "0.146.0") {
    throw new SessionMaintenanceError(
      "ADAPTER_INCOMPATIBLE",
      `Unsupported Codex catalog contract: ${instance.platform}/${instance.platformVersion}`,
    );
  }

  const database = openCodexDatabase(instance.root);
  let rows: CodexThreadRow[];
  try {
    rows = database
      .prepare(
        `SELECT id, rollout_path, title, name, cwd, created_at, updated_at, updated_at_ms, archived
         FROM threads ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC, id`,
      )
      .all() as unknown as CodexThreadRow[];
  } finally {
    database.close();
  }

  const seen = new Set<string>();
  const start = cursor === undefined ? 0 : Number.parseInt(cursor.opaque, 10);
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new TypeError(`Invalid Codex scan cursor: ${cursor?.opaque}`);
  }

  for (const [index, row] of rows.entries()) {
    if (seen.has(row.id)) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", `Duplicate Codex thread ID: ${row.id}`);
    }
    seen.add(row.id);
    if (index < start) {
      continue;
    }

    const path = await resolveContainedRollout(instance.root, row.rollout_path);
    const info = await stat(path, { bigint: true });
    yield {
      key: { platform: "codex", instanceId: instance.id, sessionId: row.id },
      title: row.title || row.name || row.id,
      archived: Boolean(row.archived),
      workspaceId: codexWorkspaceId(row.cwd),
      workspaceLabel: codexWorkspaceLabel(row.cwd),
      updatedAt: new Date(row.updated_at_ms ?? row.updated_at * 1000).toISOString(),
      hint: { size: Number(info.size), mtimeNs: info.mtimeNs.toString() },
    };
  }
}
