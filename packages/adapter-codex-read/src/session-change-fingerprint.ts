import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { RegisteredInstance } from "@linmu/dsh-session-contracts";
import { CODEX_SUPPORTED_VERSION } from "./probe.js";
import { readThread, resolveContainedRollout, withCodexReadSnapshot } from "./stable-read.js";
import { codexDisplayTitle, isUserFacingCodexThread } from "./thread.js";

export interface CodexSessionChangeStamp {
  readonly fingerprint: string;
  readonly bodyFingerprint: string;
  readonly title: string;
}

/** Cheap change detection for one explicitly selected source; never reads its body. */
export async function readCodexSessionChangeFingerprint(
  instance: RegisteredInstance,
  threadId: string,
  options: { readonly fixtureGuard?: (root: string) => void } = {},
): Promise<string> {
  return (await readCodexSessionChangeStamp(instance, threadId, options)).fingerprint;
}

/** Both hashes and the display title describe the same captured metadata row. */
export async function readCodexSessionChangeStamp(
  instance: RegisteredInstance,
  threadId: string,
  options: { readonly fixtureGuard?: (root: string) => void } = {},
): Promise<CodexSessionChangeStamp> {
  if (process.env.VITEST !== undefined && options.fixtureGuard === undefined) {
    throw new Error("Codex session fingerprint requires a fixture guard under Vitest");
  }
  options.fixtureGuard?.(instance.root);
  if (instance.platform !== "codex" || instance.platformVersion !== CODEX_SUPPORTED_VERSION) {
    throw new TypeError("Unsupported Codex session fingerprint contract");
  }
  const thread = withCodexReadSnapshot(instance.root, db => readThread(db, threadId));
  if (thread === undefined || !isUserFacingCodexThread(thread)) throw new Error(`Codex source thread is unavailable: ${threadId}`);
  const path = await resolveContainedRollout(instance.root, thread.rollout_path);
  const file = await stat(path, { bigint: true });
  const value = { thread, path, file: { size: String(file.size), mtimeNs: String(file.mtimeNs),
    ctimeNs: String(file.ctimeNs), birthtimeNs: String(file.birthtimeNs), dev: String(file.dev), ino: String(file.ino) } };
  const { title: _title, name: _name, updated_at: _updatedAt, updated_at_ms: _updatedAtMs, ...bodyThread } = thread;
  return {
    fingerprint: `codex-source-v1:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`,
    bodyFingerprint: `codex-body-v1:${createHash("sha256").update(JSON.stringify({ ...value, thread: bodyThread })).digest("hex")}`,
    title: codexDisplayTitle(thread),
  };
}
