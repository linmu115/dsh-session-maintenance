import {
  SESSION_MAINTENANCE_ERROR_CODES,
  SessionMaintenanceError,
  type JsonValue,
  type SessionMaintenanceErrorCode,
} from "@linmu/dsh-session-contracts";
import { canonicalJson } from "@linmu/dsh-session-domain";
import type {
  DshCoreApplyRequest,
  DshCoreProbe,
  DshCoreSnapshot,
  DshCoreState,
} from "@linmu/dsh-core-extension";

import { DshGatewayTokenService } from "./auth.js";
import type {
  DshGatewayClientPort,
  DshGatewayPort,
  DshGatewayRequest,
  DshGatewayScope,
  RemoteDshGatewayConnection,
  RemoteDshGatewayConnectionProvider,
} from "./contract.js";

export interface RemoteDshHostGatewayOptions {
  readonly connections: RemoteDshGatewayConnectionProvider;
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

type GatewayEnvelope =
  | { readonly kind: "probe"; readonly token: string; readonly scope: DshGatewayScope }
  | { readonly kind: "invoke"; readonly token: string; readonly scope: DshGatewayScope; readonly request: DshGatewayRequest };

function assertLoopbackOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new SessionMaintenanceError("LOOPBACK_ONLY", "DSH Core gateway must use a plain 127.0.0.1 origin");
  }
  if (url.port === "") throw new SessionMaintenanceError("LOOPBACK_ONLY", "DSH Core gateway origin requires a port");
  return url.origin;
}

async function boundedResponse(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new SessionMaintenanceError("WRITE_CAPABILITY_UNAVAILABLE", "DSH Core gateway response exceeds its limit");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new SessionMaintenanceError("WRITE_CAPABILITY_UNAVAILABLE", "DSH Core gateway response exceeds its limit");
    }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function remoteCode(text: string): SessionMaintenanceErrorCode {
  try {
    const value = JSON.parse(text) as { readonly error?: { readonly code?: unknown } };
    return typeof value.error?.code === "string" && SESSION_MAINTENANCE_ERROR_CODES.includes(value.error.code as SessionMaintenanceErrorCode)
      ? value.error.code as SessionMaintenanceErrorCode
      : "ADAPTER_INCOMPATIBLE";
  } catch {
    return "ADAPTER_INCOMPATIBLE";
  }
}

export class RemoteDshHostGateway implements DshGatewayPort {
  readonly connections: RemoteDshGatewayConnectionProvider;
  readonly fetchImpl: typeof fetch;
  readonly endpoint: string;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;

  constructor(options: RemoteDshHostGatewayOptions) {
    this.connections = options.connections;
    this.fetchImpl = options.fetch ?? fetch;
    this.endpoint = options.endpoint ?? "/dsh-session-maintenance/core";
    this.maxRequestBytes = options.maxRequestBytes ?? 64 * 1024 * 1024;
    this.maxResponseBytes = options.maxResponseBytes ?? 64 * 1024 * 1024;
  }

  probeInstance(instanceId: string): Promise<DshCoreProbe> {
    const scope: DshGatewayScope = {
      transactionId: "probe",
      planHash: "probe",
      instanceId,
      sessionId: "probe",
    };
    return this.call(scope, undefined) as Promise<DshCoreProbe>;
  }

  client(scope: DshGatewayScope): DshGatewayClientPort {
    return new RemoteDshGatewayClient(this, scope);
  }

  async invoke(scope: DshGatewayScope, request: DshGatewayRequest): Promise<DshCoreSnapshot | DshCoreState> {
    return this.call(scope, request) as Promise<DshCoreSnapshot | DshCoreState>;
  }

  private async call(
    scope: DshGatewayScope,
    request: DshGatewayRequest | undefined,
  ): Promise<DshCoreProbe | DshCoreSnapshot | DshCoreState> {
    const connection = await this.connections.current(scope.instanceId);
    const origin = assertLoopbackOrigin(connection.origin);
    const tokens = new DshGatewayTokenService({ secret: connection.secret });
    const envelope: GatewayEnvelope = request === undefined
      ? { kind: "probe", token: tokens.issue(scope), scope }
      : { kind: "invoke", token: tokens.issue(scope), scope, request };
    const serialized = canonicalJson(envelope as unknown as JsonValue);
    if (Buffer.byteLength(serialized) > this.maxRequestBytes) {
      throw new SessionMaintenanceError("WRITE_CAPABILITY_UNAVAILABLE", "DSH Core gateway request exceeds its limit");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${origin}${this.endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: serialized,
      });
    } catch {
      throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "DSH Core gateway is offline");
    }
    const text = await boundedResponse(response, this.maxResponseBytes);
    if (!response.ok) {
      throw new SessionMaintenanceError(
        remoteCode(text),
        "DSH Core gateway rejected the scoped operation",
      );
    }
    try {
      const payload = JSON.parse(text) as { readonly ok?: unknown; readonly result?: unknown };
      if (payload.ok !== true || payload.result === undefined) throw new Error("missing result");
      return payload.result as DshCoreProbe | DshCoreSnapshot | DshCoreState;
    } catch (error) {
      throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "DSH Core gateway returned an invalid response", { cause: error });
    }
  }
}

class RemoteDshGatewayClient implements DshGatewayClientPort {
  constructor(
    private readonly gateway: RemoteDshHostGateway,
    private readonly scope: DshGatewayScope,
  ) {}

  capture(workspaceId?: string): Promise<DshCoreSnapshot> {
    return this.gateway.invoke(this.scope, { operation: "capture", ...(workspaceId === undefined ? {} : { workspaceId }) }) as Promise<DshCoreSnapshot>;
  }

  observe(workspaceId?: string): Promise<DshCoreSnapshot> {
    return this.gateway.invoke(this.scope, { operation: "observe", ...(workspaceId === undefined ? {} : { workspaceId }) }) as Promise<DshCoreSnapshot>;
  }

  apply(request: DshCoreApplyRequest): Promise<DshCoreState> {
    return this.gateway.invoke(this.scope, { operation: "apply", request }) as Promise<DshCoreState>;
  }

  restore(snapshot: DshCoreSnapshot): Promise<DshCoreState> {
    return this.gateway.invoke(this.scope, { operation: "restore", snapshot }) as Promise<DshCoreState>;
  }
}
