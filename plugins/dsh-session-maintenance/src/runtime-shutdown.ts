import type { IncomingMessage, ServerResponse } from "node:http";

import type { EngineConnectionProvider } from "./engine-proxy.js";

export const RUNTIME_SHUTDOWN_ENDPOINT = "/dsh-session-maintenance/runtime/shutdown";
const MAX_BODY_BYTES = 4096;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

interface RuntimeShutdownBody {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly clientId: string;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new TypeError("Runtime shutdown body is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function validateRuntimeShutdownBody(
  value: unknown,
  expected: { readonly runId: string; readonly ownerClientId: string },
): RuntimeShutdownBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Runtime shutdown body must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schemaVersion", "runId", "clientId"].includes(key))) {
    throw new TypeError("Runtime shutdown body contains unsupported fields");
  }
  if (record.schemaVersion !== 1 || typeof record.runId !== "string" || typeof record.clientId !== "string") {
    throw new TypeError("Runtime shutdown body is invalid");
  }
  if (!SAFE_ID.test(record.runId) || !SAFE_ID.test(record.clientId)) throw new TypeError("Runtime shutdown IDs are invalid");
  if (record.runId !== expected.runId || record.clientId !== expected.ownerClientId) {
    throw new Error("Runtime shutdown owner does not match the active projection run");
  }
  return record as unknown as RuntimeShutdownBody;
}

/**
 * Lets a process owner request DSH's official appExit path. The handler is
 * run-scoped and protected by the Engine capability; no filesystem path or
 * token is accepted in the request body.
 */
export function createRuntimeShutdownHandler(input: {
  readonly connection: EngineConnectionProvider;
  readonly runId: string;
  readonly ownerClientId: string;
  readonly exit: (code: number) => void;
  readonly schedule?: (callback: () => void) => void;
}) {
  const schedule = input.schedule ?? ((callback: () => void) => { setImmediate(callback); });
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== RUNTIME_SHUTDOWN_ENDPOINT) {
      sendJson(response, 404, { ok: false, error: "Runtime shutdown endpoint not found" });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      sendJson(response, 405, { ok: false, error: "Runtime shutdown requires POST" });
      return;
    }
    try {
      const connection = await input.connection.current();
      if (request.headers.authorization !== `Bearer ${connection.token}`) {
        sendJson(response, 401, { ok: false, error: "Runtime shutdown capability is invalid" });
        return;
      }
      validateRuntimeShutdownBody(await readBody(request), input);
      sendJson(response, 202, { ok: true, runId: input.runId, state: "shutdown-requested" });
      schedule(() => { input.exit(0); });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 300) : "Runtime shutdown request failed",
      });
    }
  };
}
