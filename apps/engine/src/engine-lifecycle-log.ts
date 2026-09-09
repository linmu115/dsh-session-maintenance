import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const processStartedAt = new Date(Date.now() - process.uptime() * 1_000).toISOString();
const safeSystemCodes = new Set(["EADDRINUSE", "EACCES", "EPERM", "ENOENT", "ENOSPC", "SQLITE_CANTOPEN", "SQLITE_BUSY", "SQLITE_CORRUPT"]);

// A small, per-process audit trail. Never persist error messages, request data,
// tokens, or session content; these can occur in arbitrary exception strings.
export function lifecycleErrorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (typeof code === "string" && safeSystemCodes.has(code)) return code;
  const message = error instanceof Error ? error.message : "";
  return /^(WRITER_[A-Z_]+|ENGINE_[A-Z_]+)(?=:|$)/u.exec(message)?.[1] ?? "ENGINE_START_FAILED";
}

export function recordEngineLifecycle(stateRoot: string, stage: string, code?: string): void {
  try {
    const directory = join(stateRoot, "logs", "engine-lifecycle");
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, `${process.pid}.jsonl`), `${JSON.stringify({
      at: new Date().toISOString(), pid: process.pid, parentPid: process.ppid, processStartedAt,
      stage, ...(code === undefined ? {} : { code }),
    })}\n`, { mode: 0o600 });
  } catch { /* Diagnostics must not prevent ownership release or recovery. */ }
}

export function readEngineStartupFailure(stateRoot: string, pid: number, since: number): string | undefined {
  try {
    const lines = readFileSync(join(stateRoot, "logs", "engine-lifecycle", `${pid}.jsonl`), "utf8").split("\n");
    for (const line of lines.reverse()) {
      if (!line) continue;
      const event = JSON.parse(line) as { at: string; stage: string; code?: string };
      if (Date.parse(event.at) >= since && event.stage === "startup.failed" &&
          typeof event.code === "string" && (/^(WRITER|ENGINE)_[A-Z_]+$/u.test(event.code) || safeSystemCodes.has(event.code))) return event.code;
    }
  } catch { /* Child may have failed before CLI initialization. */ }
  return undefined;
}
