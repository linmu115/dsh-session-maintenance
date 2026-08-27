import { createHash, randomBytes } from "node:crypto";

import {
  SessionMaintenanceError,
  confirmationScopeSchema,
  type ConfirmationScope,
  type IssuedConfirmation,
  type TransactionRepository,
} from "@linmu/dsh-session-contracts";

export interface ConfirmationServiceOptions {
  readonly now?: () => Date;
  readonly randomToken?: () => string;
  readonly ttlMs?: number;
}

function tokenHash(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

export class ConfirmationService {
  readonly repository: TransactionRepository;
  readonly now: () => Date;
  readonly randomToken: () => string;
  readonly ttlMs: number;

  constructor(repository: TransactionRepository, options: ConfirmationServiceOptions = {}) {
    this.repository = repository;
    this.now = options.now ?? (() => new Date());
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
  }

  async issue(scope: ConfirmationScope): Promise<IssuedConfirmation> {
    confirmationScopeSchema.parse(scope);
    const token = this.randomToken();
    if (token.length < 8) throw new TypeError("Confirmation token source is too short");
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.ttlMs);
    await this.repository.saveConfirmation({
      tokenHash: tokenHash(token),
      operation: scope.operation,
      resourceId: scope.resourceId,
      operationHash: scope.operationHash,
      expiresAt: expiresAt.toISOString(),
      createdAt: createdAt.toISOString(),
      consumedAt: null,
    });
    return { ...scope, token, expiresAt: expiresAt.toISOString() };
  }

  async consume(input: IssuedConfirmation): Promise<void> {
    return this.consumeToken(input.token, {
      operation: input.operation,
      resourceId: input.resourceId,
      operationHash: input.operationHash,
    });
  }

  async consumeToken(token: string, scope: ConfirmationScope): Promise<void> {
    confirmationScopeSchema.parse(scope);
    const stored = await this.repository.getConfirmation(tokenHash(token));
    if (stored === undefined || stored.consumedAt !== null) {
      throw new SessionMaintenanceError(
        "CONFIRMATION_REQUIRED",
        "Confirmation token is missing or already used",
      );
    }
    if (
      stored.operation !== scope.operation ||
      stored.resourceId !== scope.resourceId ||
      stored.operationHash !== scope.operationHash
    ) {
      throw new SessionMaintenanceError(
        "CONFIRMATION_SCOPE_MISMATCH",
        "Confirmation token does not match this operation",
      );
    }
    const now = this.now();
    if (Date.parse(stored.expiresAt) <= now.getTime()) {
      throw new SessionMaintenanceError("CONFIRMATION_EXPIRED", "Confirmation token has expired");
    }
    if (!(await this.repository.consumeConfirmation(stored.tokenHash, now.toISOString()))) {
      throw new SessionMaintenanceError(
        "CONFIRMATION_REQUIRED",
        "Confirmation token was consumed concurrently",
      );
    }
  }
}
