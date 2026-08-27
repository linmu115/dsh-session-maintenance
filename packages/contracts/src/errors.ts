import type { JsonValue } from "./model.js";

export const SESSION_MAINTENANCE_ERROR_CODES = [
  "UNSTABLE_READ",
  "PLAN_STALE",
  "ADAPTER_INCOMPATIBLE",
  "CAPABILITY_NOT_AVAILABLE",
  "LIVE_HOME_FORBIDDEN",
  "RECOVERY_REQUIRED",
  "IDENTITY_CONFLICT",
  "OBJECT_CORRUPT",
  "VERSION_ID_COLLISION",
  "LOOPBACK_ONLY",
  "DSH_BUSY",
  "WRITE_CAPABILITY_UNAVAILABLE",
  "TRANSACTION_IN_PROGRESS",
  "TRANSACTION_NOT_FOUND",
  "TRANSACTION_NOT_RESTORABLE",
  "BACKUP_INCOMPLETE",
  "BACKUP_CORRUPT",
  "VERIFICATION_FAILED",
  "RESTORE_FAILED",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED",
  "CONFIRMATION_SCOPE_MISMATCH",
  "UI_CONTRACT_INCOMPATIBLE",
] as const;

export type SessionMaintenanceErrorCode = (typeof SESSION_MAINTENANCE_ERROR_CODES)[number];

export class SessionMaintenanceError extends Error {
  readonly code: SessionMaintenanceErrorCode;
  readonly details: JsonValue | undefined;

  constructor(
    code: SessionMaintenanceErrorCode,
    message: string,
    options: { readonly details?: JsonValue; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SessionMaintenanceError";
    this.code = code;
    this.details = options.details;
  }
}
