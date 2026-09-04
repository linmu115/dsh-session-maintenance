import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  SessionMaintenanceError,
  type ObservationHint,
  type PlatformSessionKey,
  type RegisteredInstance,
  type StableObservation,
  type UnstableRead,
} from "@linmu/dsh-session-contracts";

import {
  MAX_CODEX_ROLLOUT_BYTES,
  parseCodexJsonlChunks,
  type CodexThreadRow,
} from "./parser.js";
import type { CodexReadStatusEvent } from "./status.js";
import { isUserFacingCodexThread } from "./thread.js";

export interface CodexReadHooks {
  readonly fixtureGuard?: (root: string) => void;
  readonly afterRead?: (path: string) => void | Promise<void>;
  readonly onBodyRead?: () => void;
  readonly onStatus?: (event: CodexReadStatusEvent) => void | Promise<void>;
}

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function resolveContainedRollout(root: string, rolloutPath: string): Promise<string> {
  const resolvedRoot = await realpath(root);
  const candidate = isAbsolute(rolloutPath) ? rolloutPath : resolve(root, rolloutPath);
  const resolvedRollout = await realpath(candidate);
  if (!contained(resolvedRoot, resolvedRollout)) {
    throw new SessionMaintenanceError(
      "LIVE_HOME_FORBIDDEN",
      `Rollout path escapes registered Codex root: ${rolloutPath}`,
    );
  }
  return resolvedRollout;
}

export function openCodexDatabase(root: string): DatabaseSync {
  const database = new DatabaseSync(resolve(root, "state_5.sqlite"), { readOnly: true, timeout: 250 });
  database.exec("PRAGMA query_only = ON");
  return database;
}

/**
 * Execute catalog work in one SQLite read transaction. In WAL mode SQLite
 * pins a consistent snapshot while a live Codex writer continues appending.
 * This never checkpoints, locks, or writes the Codex database.
 */
export function withCodexReadSnapshot<T>(
  root: string,
  read: (database: DatabaseSync) => T,
): T {
  const database = openCodexDatabase(root);
  database.exec("BEGIN");
  try {
    return read(database);
  } finally {
    database.exec("ROLLBACK");
    database.close();
  }
}

export function readThread(database: DatabaseSync, id: string): CodexThreadRow | undefined {
  return database
    .prepare(
      `SELECT id, rollout_path, source, agent_role, title, name, cwd, created_at, updated_at, updated_at_ms, archived, project_id
       FROM threads WHERE id = ?`,
    )
    .get(id) as CodexThreadRow | undefined;
}

export async function observeCodexSession(
  instance: RegisteredInstance,
  key: PlatformSessionKey,
  hint: ObservationHint | undefined,
  hooks: CodexReadHooks,
): Promise<StableObservation | UnstableRead> {
  hooks.fixtureGuard?.(instance.root);
  if (
    instance.platform !== "codex" ||
    key.platform !== "codex" ||
    key.instanceId !== instance.id
  ) {
    throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "Codex observation key mismatch");
  }

  const thread = withCodexReadSnapshot(instance.root, (database) =>
    readThread(database, key.sessionId),
  );
  if (thread === undefined || !isUserFacingCodexThread(thread)) {
    throw new SessionMaintenanceError(
      "ADAPTER_INCOMPATIBLE",
      `Codex thread is absent from the registered catalog: ${key.sessionId}`,
    );
  }

  const path = await resolveContainedRollout(instance.root, thread.rollout_path);
  const before = await stat(path, { bigint: true });
  if (before.size > BigInt(MAX_CODEX_ROLLOUT_BYTES)) {
    throw new SessionMaintenanceError(
      "CONTENT_TOO_LARGE",
      `Codex rollout exceeds ${MAX_CODEX_ROLLOUT_BYTES} bytes`,
    );
  }
  if (
    (hint?.size !== undefined && BigInt(hint.size) !== before.size) ||
    (hint?.mtimeNs !== undefined && hint.mtimeNs !== before.mtimeNs.toString())
  ) {
    await hooks.onStatus?.({
      stage: "rollout.stability",
      state: "succeeded",
      instanceId: instance.id,
      sessionId: key.sessionId,
      consistency: "bounded-prefix",
      detail: "catalog advanced before capture; reading a fresh bounded prefix",
    });
  }

  hooks.onBodyRead?.();
  const parsed = await parseCodexJsonlChunks(createReadStream(path, {
    start: 0,
    end: Number(before.size) - 1,
  }));
  await hooks.afterRead?.(path);
  const after = await stat(path, { bigint: true });
  if (after.size < before.size || after.dev !== before.dev || after.ino !== before.ino) {
    await hooks.onStatus?.({
      stage: "rollout.stability",
      state: "retry",
      instanceId: instance.id,
      sessionId: key.sessionId,
      consistency: "bounded-prefix",
      detail: "rollout was replaced or truncated during bounded-prefix capture",
    });
    return { kind: "unstable", key, reason: "Rollout was replaced or truncated during read", retryable: true };
  }

  const envelopes = parsed.envelopes;
  const rootMeta = envelopes[0];
  if (rootMeta?.type !== "session_meta" || rootMeta.payload.id !== key.sessionId) {
    throw new SessionMaintenanceError(
      "IDENTITY_CONFLICT",
      `Codex root session_meta ID does not match catalog ID: ${key.sessionId}`,
    );
  }
  await hooks.onStatus?.({
    stage: "rollout.stability",
    state: "succeeded",
    instanceId: instance.id,
    sessionId: key.sessionId,
    consistency: "bounded-prefix",
    detail: `streamed ${parsed.bytesRead} stable rollout bytes from an append-safe prefix`,
  });
  return {
    kind: "stable",
    key,
    fingerprint: {
      ...key,
      kind: "content",
      value: parsed.digest,
    },
    payload: { format: "codex-0.146.0", thread, envelopes },
  };
}
