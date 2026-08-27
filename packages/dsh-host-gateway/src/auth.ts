import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { SessionMaintenanceError, type JsonValue } from "@linmu/dsh-session-contracts";
import { canonicalJson } from "@linmu/dsh-session-domain";

import type { DshGatewayScope } from "./contract.js";

interface GatewayTokenPayload extends DshGatewayScope {
  readonly schemaVersion: 1;
  readonly expiresAt: number;
  readonly nonce: string;
}

export interface DshGatewayTokenServiceOptions {
  readonly secret: Uint8Array;
  readonly now?: () => Date;
  readonly ttlMs?: number;
}

function scopeJson(scope: DshGatewayScope): JsonValue {
  return {
    transactionId: scope.transactionId,
    planHash: scope.planHash,
    instanceId: scope.instanceId,
    sessionId: scope.sessionId,
  };
}

function scopeEqual(left: DshGatewayScope, right: DshGatewayScope): boolean {
  return canonicalJson(scopeJson(left)) === canonicalJson(scopeJson(right));
}

export class DshGatewayTokenService {
  readonly secret: Buffer;
  readonly now: () => Date;
  readonly ttlMs: number;
  private readonly consumedNonces = new Map<string, number>();

  constructor(options: DshGatewayTokenServiceOptions) {
    if (options.secret.byteLength < 32) throw new TypeError("Gateway secret must be at least 32 bytes");
    this.secret = Buffer.from(options.secret);
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 60_000;
  }

  issue(scope: DshGatewayScope): string {
    const payload: GatewayTokenPayload = {
      schemaVersion: 1,
      ...scope,
      expiresAt: this.now().getTime() + this.ttlMs,
      nonce: randomBytes(16).toString("hex"),
    };
    const body = Buffer.from(canonicalJson(payload as unknown as JsonValue)).toString("base64url");
    return `${body}.${this.sign(body).toString("base64url")}`;
  }

  verify(token: string, expected: DshGatewayScope): void {
    const [body, signature, extra] = token.split(".");
    if (body === undefined || signature === undefined || extra !== undefined) this.reject();
    const supplied = Buffer.from(signature, "base64url");
    const expectedSignature = this.sign(body);
    if (supplied.byteLength !== expectedSignature.byteLength || !timingSafeEqual(supplied, expectedSignature)) {
      this.reject();
    }
    let payload: GatewayTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as GatewayTokenPayload;
    } catch {
      this.reject();
    }
    if (
      payload.schemaVersion !== 1 ||
      !scopeEqual(payload, expected) ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.expiresAt < this.now().getTime() ||
      typeof payload.nonce !== "string" ||
      !/^[a-f0-9]{32}$/u.test(payload.nonce)
    ) {
      this.reject();
    }
    const now = this.now().getTime();
    for (const [nonce, expiresAt] of this.consumedNonces) {
      if (expiresAt < now) this.consumedNonces.delete(nonce);
    }
    if (this.consumedNonces.has(payload.nonce)) this.reject();
    this.consumedNonces.set(payload.nonce, payload.expiresAt);
  }

  private sign(body: string): Buffer {
    return createHmac("sha256", this.secret).update(body).digest();
  }

  private reject(): never {
    throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "DSH host gateway token is invalid");
  }
}
