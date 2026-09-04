import type {
  AdapterId,
  AuthorityScope,
  BranchId,
  CheckpointId,
  LeaseId,
  LogicalProjectId,
  LogicalSessionId,
  LogicalWorkspaceId,
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

export interface ProjectionCacheSessionStateV1 {
  readonly schemaVersion: 1;
  readonly logicalSessionId: LogicalSessionId;
  readonly nativeSessionId: NativeSessionId;
  readonly canonicalHeadVersionId: SessionVersionId | null;
  readonly canonicalUpdatedAt: string;
  /** Lightweight runtime metadata; never contains message or tool-call bodies. */
  readonly title: string;
  readonly tags: readonly string[];
  readonly archivedAt: string | null;
  readonly workspaceId: LogicalWorkspaceId | null;
  readonly projectId: LogicalProjectId | null;
  readonly authorityScope: AuthorityScope;
  /** Native prefix already represented by the cached canonical head. */
  readonly nativeRevision: number;
  readonly nativeDigest: string;
}

export interface ProjectionCacheWorkspaceStateV1 {
  readonly schemaVersion: 1;
  readonly nativeWorkspaceId: string;
  readonly nativeDigest: string;
}

/** Durable metadata for a rebuildable native-format projection cache. */
export interface PersistentProjectionCacheManifestV1 {
  readonly schemaVersion: 1;
  readonly cacheKey: string;
  readonly adapterId: AdapterId;
  readonly adapterFingerprint: string;
  readonly configurationDigest: string;
  readonly lastAppliedRevision: number;
  readonly sessions: readonly ProjectionCacheSessionStateV1[];
  readonly workspaces: readonly ProjectionCacheWorkspaceStateV1[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectionDeltaApplyReceiptV1 {
  readonly schemaVersion: 1;
  readonly cacheKey: string;
  readonly baseline: boolean;
  readonly fromRevision: number;
  readonly throughRevision: number;
  readonly currentRevision: number;
  readonly changedSessions: number;
  readonly rewrittenSessions: number;
  readonly removedSessions: number;
  readonly unchangedSessions: number;
  readonly rewrittenWorkspaces: number;
  readonly removedWorkspaces: number;
}
