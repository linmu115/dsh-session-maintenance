import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  RemoteDshGatewayConnection,
  RemoteDshGatewayConnectionProvider,
} from "@linmu/dsh-host-gateway";
import { SessionMaintenanceError } from "@linmu/dsh-session-contracts";

export interface DshGatewayTarget {
  readonly instanceId: string;
  readonly origin: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function loopbackOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new SessionMaintenanceError("LOOPBACK_ONLY", "DSH Core gateway target must be a plain 127.0.0.1 origin");
  }
  return url.origin;
}

/**
 * Reads the Engine's ACL-protected, rotating connection descriptor only on the
 * Engine host.  The same ephemeral token is the HMAC secret understood by the
 * DSH host plugin; it is never added to config, DTOs or browser state.
 */
export class EngineDescriptorDshGatewayConnections implements RemoteDshGatewayConnectionProvider {
  private readonly origins: ReadonlyMap<string, string>;
  private readonly descriptorPath: string;

  constructor(stateRoot: string, targets: readonly DshGatewayTarget[]) {
    const origins = new Map<string, string>();
    for (const target of targets) {
      if (!SAFE_ID.test(target.instanceId) || origins.has(target.instanceId)) {
        throw new TypeError(`Invalid or duplicate DSH gateway instance ID: ${target.instanceId}`);
      }
      origins.set(target.instanceId, loopbackOrigin(target.origin));
    }
    this.origins = origins;
    this.descriptorPath = join(stateRoot, "connection.json");
  }

  async current(instanceId: string): Promise<RemoteDshGatewayConnection> {
    const origin = this.origins.get(instanceId);
    if (origin === undefined) {
      throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", `No DSH Core gateway is registered for instance: ${instanceId}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.descriptorPath, "utf8"));
    } catch {
      throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "Engine connection descriptor is unavailable");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "Engine connection descriptor is invalid");
    }
    const record = value as Record<string, unknown>;
    if (
      record.schemaVersion !== 1 ||
      record.host !== "127.0.0.1" ||
      !Number.isSafeInteger(record.port) ||
      typeof record.token !== "string" ||
      !/^[A-Za-z0-9_-]{32,256}$/u.test(record.token)
    ) {
      throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "Engine connection descriptor is not loopback v1");
    }
    return { origin, secret: Buffer.from(record.token) };
  }
}
