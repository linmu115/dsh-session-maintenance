import type {
  AdapterId,
  BranchId,
  CheckpointId,
  LeaseId,
  LogicalSessionId,
  NativeSessionId,
  OperationId,
  RunId,
  SessionVersionId,
} from "./canonical.js";

export type ProjectionRunState =
  | "preparing"
  | "running"
  | "draining"
  | "verifying"
  | "closed"
  | "recovery-required"
  | "recovering"
  | "recovered"
  | "quarantined"
  | "cleanup-pending";

export type ProjectionSessionMode =
  | "maintenance-write"
  | "codex-read-until-write"
  | "hidden"
  | "recovery-only";

export type ProjectionOperationStatus = "pending" | "committed" | "failed" | "quarantined";

export interface ProjectionRun {
  readonly schemaVersion: 1;
  readonly id: RunId;
  readonly leaseId: LeaseId;
  readonly branchId: BranchId;
  readonly instanceId: string;
  readonly profileId: string;
  readonly dshVersion: string;
  readonly adapterId: AdapterId;
  readonly state: ProjectionRunState;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly checkpointId: CheckpointId | null;
}

export interface ProjectionSession {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly nativeSessionId: NativeSessionId;
  readonly logicalSessionId: LogicalSessionId;
  readonly baseVersionId: SessionVersionId | null;
  readonly mode: ProjectionSessionMode;
  readonly nativeRevision: number;
  readonly lastCommittedOperationId: OperationId | null;
  readonly derivedChildSessionId: LogicalSessionId | null;
}

export interface ProjectionOperationReceipt {
  readonly schemaVersion: 1;
  readonly operationId: OperationId;
  readonly runId: RunId;
  readonly logicalSessionId: LogicalSessionId;
  readonly nativeSessionId: NativeSessionId;
  readonly status: ProjectionOperationStatus;
  readonly canonicalVersionId: SessionVersionId | null;
  readonly projectionRevision: number;
  readonly committedAt: string | null;
}
