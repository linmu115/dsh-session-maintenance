import type { IncomingMessage, ServerResponse } from "node:http";

import { SessionMaintenanceError } from "@linmu/dsh-session-contracts";

import type { DshGatewayRequest, DshGatewayScope } from "./contract.js";
import type { DshHostGateway } from "./gateway.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface DshGatewayHttpHandlerOptions {
  readonly endpoint?: string;
  readonly maxRequestBytes?: number;
  createGateway(scope: DshGatewayScope): Promise<DshHostGateway>;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      throw new SessionMaintenanceError(
        "WRITE_CAPABILITY_UNAVAILABLE",
        `DSH Core gateway payload exceeds ${maxBytes} bytes`,
      );
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function parseScope(value: unknown): DshGatewayScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Core gateway scope is missing");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    Object.keys(record).some((key) => !["transactionId", "planHash", "instanceId", "sessionId"].includes(key))
  ) {
    throw new TypeError("Core gateway scope has unknown fields");
  }
  for (const key of ["transactionId", "planHash", "instanceId", "sessionId"] as const) {
    if (typeof record[key] !== "string" || !SAFE_ID.test(record[key])) {
      throw new TypeError(`Invalid Core gateway scope: ${key}`);
    }
  }
  return record as unknown as DshGatewayScope;
}

function parseRequest(value: unknown): DshGatewayRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Core gateway request is missing");
  }
  const operation = (value as { readonly operation?: unknown }).operation;
  if (!new Set(["capture", "observe", "apply", "restore"]).has(String(operation))) {
    throw new TypeError("Core gateway operation is unsupported");
  }
  return value as DshGatewayRequest;
}

function publicCode(error: unknown): string {
  return error instanceof SessionMaintenanceError ? error.code : "ADAPTER_INCOMPATIBLE";
}

/**
 * Host-only loopback endpoint.  It deliberately returns only stable error
 * codes: DSH paths, service details and the rotating HMAC secret never cross
 * this boundary.
 */
export function createDshGatewayHttpHandler(options: DshGatewayHttpHandlerOptions) {
  const endpoint = options.endpoint ?? "/dsh-session-maintenance/core";
  const maxRequestBytes = options.maxRequestBytes ?? 64 * 1024 * 1024;
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== endpoint) {
      send(response, 404, { ok: false, error: { code: "NOT_FOUND" } });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      send(response, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED" } });
      return;
    }
    try {
      const value = await readJson(request, maxRequestBytes);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("Invalid Core gateway envelope");
      }
      const envelope = value as Record<string, unknown>;
      if (
        typeof envelope.token !== "string" ||
        (envelope.kind !== "probe" && envelope.kind !== "invoke") ||
        Object.keys(envelope).some((key) => !["kind", "token", "scope", "request"].includes(key))
      ) {
        throw new TypeError("Invalid Core gateway envelope");
      }
      const scope = parseScope(envelope.scope);
      const token = envelope.token;
      const gateway = await options.createGateway(scope);
      const result = envelope.kind === "probe"
        ? await (async () => {
            gateway.tokens.verify(token, scope);
            return gateway.probeInstance(scope.instanceId);
          })()
        : await gateway.invoke(token, scope, parseRequest(envelope.request));
      send(response, 200, { ok: true, result });
    } catch (error) {
      send(response, 409, { ok: false, error: { code: publicCode(error) } });
    }
  };
}
