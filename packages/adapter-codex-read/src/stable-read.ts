import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
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
  parseCodexJsonl,
  type CodexThreadRow,
} from "./parser.js";

export interface CodexReadHooks {
  readonly fixtureGuard?: (root: string) => void;
  readonly afterRead?: (path: string) => void | Promise<void>;
  readonly onBodyRead?: () => void;
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
  return new DatabaseSync(resolve(root, "state_5.sqlite"), { readOnly: true });
}

export function readThread(database: DatabaseSync, id: string): CodexThreadRow | undefined {
  return database
    .prepare(
      `SELECT id, rollout_path, title, name, cwd, created_at, updated_at, archived
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

  const database = openCodexDatabase(instance.root);
  let thread: CodexThreadRow | undefined;
  try {
    thread = readThread(database, key.sessionId);
  } finally {
    database.close();
  }
  if (thread === undefined) {
    throw new SessionMaintenanceError(
      "ADAPTER_INCOMPATIBLE",
      `Codex thread is absent from the registered catalog: ${key.sessionId}`,
    );
  }

  const path = await resolveContainedRollout(instance.root, thread.rollout_path);
  const before = await stat(path, { bigint: true });
  if (before.size > BigInt(MAX_CODEX_ROLLOUT_BYTES)) {
    throw new Error(`Codex rollout exceeds ${MAX_CODEX_ROLLOUT_BYTES} bytes`);
  }
  if (
    (hint?.size !== undefined && BigInt(hint.size) !== before.size) ||
    (hint?.mtimeNs !== undefined && hint.mtimeNs !== before.mtimeNs.toString())
  ) {
    return { kind: "unstable", key, reason: "Catalog fingerprint changed before read", retryable: true };
  }

  hooks.onBodyRead?.();
  const bytes = await readFile(path);
  await hooks.afterRead?.(path);
  const after = await stat(path, { bigint: true });
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    return { kind: "unstable", key, reason: "Rollout changed during read", retryable: true };
  }

  const envelopes = parseCodexJsonl(bytes);
  const sessionMeta = envelopes.find((envelope) => envelope.type === "session_meta");
  if (sessionMeta?.payload.id !== key.sessionId) {
    throw new Error(`Codex session_meta ID does not match catalog ID: ${key.sessionId}`);
  }
  return {
    kind: "stable",
    key,
    fingerprint: {
      ...key,
      kind: "content",
      value: createHash("sha256").update(bytes).digest("hex"),
    },
    payload: { format: "codex-0.146.0", thread, envelopes },
  };
}
