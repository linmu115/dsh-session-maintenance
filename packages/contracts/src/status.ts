import type {
  AdapterId,
  LeaseId,
  LogicalSessionId,
  NativeSessionId,
  OperationId,
  RunId,
  StatusEventId,
  StatusSpanId,
} from "./canonical.js";

export const STATUS_STAGES = [
  "run.lease",
  "projection.materialize",
  "runtime.persistence.attach",
  "session.append.commit",
  "session.derivation.create",
  "projection.cross-version.verify",
  "reference.roundtrip.verify",
  "run.shutdown-recovery",
] as const;

export type StatusStage = (typeof STATUS_STAGES)[number];
export type StatusEventState = "started" | "succeeded" | "failed";

export interface StatusEventV1 {
  readonly schemaVersion: 1;
  readonly id: StatusEventId;
  readonly at: string;
  readonly runId: RunId;
  readonly leaseId: LeaseId;
  readonly profileId: string;
  readonly adapterId: AdapterId;
  readonly dshVersion: string;
  readonly stage: StatusStage;
  readonly state: StatusEventState;
  readonly logicalSessionId: LogicalSessionId | null;
  readonly nativeSessionId: NativeSessionId | null;
  readonly operationId: OperationId | null;
  readonly parentEventId: StatusEventId | null;
  readonly spanId: StatusSpanId;
  readonly errorCode: string | null;
  readonly durationMs: number | null;
  readonly diagnosticDetailRef: string | null;
}

export interface StatusEventQuery {
  readonly cursor?: string;
  readonly limit?: number;
  readonly runId?: RunId;
  readonly logicalSessionId?: LogicalSessionId;
  readonly operationId?: OperationId;
  readonly stage?: StatusStage;
  readonly spanId?: StatusSpanId;
}
