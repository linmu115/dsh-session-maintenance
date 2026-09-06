import { stat } from "node:fs/promises";

import {
  SessionMaintenanceError,
  type PlatformSessionSummary,
  type RegisteredInstance,
  type ScanCursor,
} from "@linmu/dsh-session-contracts";

import type { CodexThreadRow } from "./parser.js";
import { resolveContainedRollout, withCodexReadSnapshot } from "./stable-read.js";
import { codexDisplayTitle, isUserFacingCodexThread } from "./thread.js";
import { codexWorkspaceId, codexWorkspaceLabel } from "./workspace.js";
import type { CodexReadStatusEvent } from "./status.js";

function readCatalogRows(instance: RegisteredInstance): readonly CodexThreadRow[] {
  return withCodexReadSnapshot(instance.root, (database) =>
    database
      .prepare(
        `SELECT id, rollout_path, source, agent_role, title, name, cwd, created_at, updated_at, updated_at_ms, archived, project_id
         FROM threads ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC, id`,
      )
      .all() as unknown as CodexThreadRow[],
  );
}

/** Internal Codex rows that an existing canonical store may need to unproject. */
export function listInternalCodexThreadIds(
  instance: RegisteredInstance,
  fixtureGuard?: (root: string) => void,
): readonly string[] {
  fixtureGuard?.(instance.root);
  return readCatalogRows(instance)
    .filter((row) => !isUserFacingCodexThread(row))
    .map((row) => row.id);
}

export async function* listCodexSessions(
  instance: RegisteredInstance,
  cursor: ScanCursor | undefined,
  fixtureGuard?: (root: string) => void,
  onStatus?: (event: CodexReadStatusEvent) => void | Promise<void>,
  threadIds?: ReadonlySet<string>,
): AsyncIterable<PlatformSessionSummary> {
  fixtureGuard?.(instance.root);
  if (instance.platform !== "codex" || instance.platformVersion !== "0.146.0") {
    throw new SessionMaintenanceError(
      "ADAPTER_INCOMPATIBLE",
      `Unsupported Codex catalog contract: ${instance.platform}/${instance.platformVersion}`,
    );
  }

  const rows = readCatalogRows(instance);
  const visibleRows = rows.filter(row => isUserFacingCodexThread(row) && (threadIds === undefined || threadIds.has(row.id)));
  await onStatus?.({
    stage: "catalog.snapshot",
    state: "succeeded",
    instanceId: instance.id,
    sessionId: null,
    consistency: "sqlite-read-transaction",
    detail: `captured ${visibleRows.length} user-facing threads; excluded ${rows.length - visibleRows.length} ${threadIds === undefined ? "internal" : "internal or unselected"} threads without requiring Codex quiescence`,
  });

  const seen = new Set<string>();
  const start = cursor === undefined ? 0 : Number.parseInt(cursor.opaque, 10);
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new TypeError(`Invalid Codex scan cursor: ${cursor?.opaque}`);
  }

  for (const [index, row] of visibleRows.entries()) {
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
      title: codexDisplayTitle(row),
      archived: Boolean(row.archived),
      workspaceId: codexWorkspaceId(row.cwd),
      workspaceLabel: codexWorkspaceLabel(row.cwd),
      updatedAt: new Date(row.updated_at_ms ?? row.updated_at * 1000).toISOString(),
      hint: { size: Number(info.size), mtimeNs: info.mtimeNs.toString() },
    };
  }
}
