import type { CanonicalProjectionInput } from "./adapter-sdk.js";
import type {
  GcPolicy,
  GcReport,
  JsonValue,
  LogicalSession,
  MatchCandidate,
  NativeMirrorRecord,
  NewVersion,
  ObservationRecord,
  ObservedHead,
  Page,
  PlatformBinding,
  PlatformSessionKey,
  RepositoryCounts,
  RepositoryWriteResult,
  SessionQuery,
  SessionSummary,
  WorkspaceSummary,
  SessionVersionManifest,
  VersionGraphData,
  VersionGraphPage,
  BackupManifest,
  BackupProtection,
  Checkpoint,
  StoredConfirmation,
  TransactionRecord,
  TransactionStep,
} from "./model.js";
import type { ContinuationJob, ContinuationTransition } from "./continuations.js";
import type { SyncPlan } from "./plans.js";
import type { PlanQuery, PlanSummary, TransactionQuery, TransactionSummary } from "./operations.js";
import type {
  CanonicalChangePage,
  CanonicalChangeQuery,
  CanonicalEventV1,
  CanonicalSessionRecord,
  LogicalSessionId,
  LogicalWorkspace,
  LogicalProject,
  LogicalProjectId,
  OperationId,
  SessionDerivation,
  SessionTombstone,
  SessionVersionId,
  WorkspaceMembership,
  ProjectMembership,
  ProjectRoot,
  NativeSessionReferenceIndexV1,
} from "./canonical.js";
import type {
  ProjectionOperationReceipt,
  ProjectionRun,
  ProjectionRunState,
  ProjectionSession,
} from "./projection.js";
import type { StatusEventQuery, StatusEventV1 } from "./status.js";

export interface VerifiedRefAdvance {
  readonly logicalSessionId: string;
  readonly sourceBindingId: string;
  readonly expectedSourceVersionId: string;
  readonly targetBinding: PlatformBinding;
  readonly expectedTargetVersionId?: string;
  readonly verifiedHead: ObservedHead;
  readonly displayTitle: string;
  readonly archived: boolean;
}

export interface SessionRepository {
  createLogicalSession(input: LogicalSession): Promise<boolean>;
  findBinding(key: PlatformSessionKey): Promise<PlatformBinding | undefined>;
  bindPlatformSession(input: PlatformBinding): Promise<boolean>;
  recordWorkspaceMembership(input: {
    readonly bindingId: string;
    readonly workspaceId: string | null;
    readonly displayName: string | null;
  }): Promise<void>;
  getObservedHead(bindingId: string): Promise<ObservedHead | undefined>;
  putVersion(input: NewVersion): Promise<SessionVersionManifest>;
  getVersion(id: string): Promise<SessionVersionManifest | undefined>;
  advanceVerifiedRefs(input: VerifiedRefAdvance): Promise<void>;
  recordObservation(input: ObservedHead): Promise<void>;
  recordObservedVersion(input: ObservationRecord): Promise<RepositoryWriteResult>;
  upsertMatchCandidate(input: MatchCandidate): Promise<boolean>;
  listMatchCandidates(logicalSessionId: string): Promise<readonly MatchCandidate[]>;
  listBindings(logicalSessionId: string): Promise<readonly PlatformBinding[]>;
  counts(): Promise<RepositoryCounts>;
  getGraph(logicalSessionId: string): Promise<VersionGraphData>;
  listSessions(query: SessionQuery): Promise<Page<SessionSummary>>;
  listWorkspaces(): Promise<readonly WorkspaceSummary[]>;
  getSessionSummary(logicalSessionId: string): Promise<SessionSummary | undefined>;
  getGraphPage(logicalSessionId: string, cursor?: string): Promise<VersionGraphPage>;
  listReachableObjectIds(): Promise<readonly string[]>;
  savePlan(plan: SyncPlan): Promise<void>;
  getPlan(id: string): Promise<SyncPlan | undefined>;
  listPlans(query: PlanQuery): Promise<Page<PlanSummary>>;
}

/** @deprecated Read only during canonical migration; do not add new callers. */
export interface NativeMirrorRepository {
  getNativeMirror(logicalSessionId: string): Promise<NativeMirrorRecord | undefined>;
  listNativeMirrors(): Promise<readonly NativeMirrorRecord[]>;
  upsertNativeMirror(input: NativeMirrorRecord): Promise<NativeMirrorRecord>;
  removeNativeMirror(logicalSessionId: string): Promise<boolean>;
  setLogicalSessionSyncMode(logicalSessionId: string, mode: LogicalSession["syncMode"]): Promise<void>;
  setCanonicalVersion(logicalSessionId: string, versionId: string): Promise<void>;
}

export interface ContentObjectStore {
  put(bytes: Uint8Array): Promise<string>;
  get(hash: string): Promise<Uint8Array>;
  collect(policy: GcPolicy): Promise<GcReport>;
}

export interface TransactionTransition {
  readonly step: TransactionStep;
  readonly result?: JsonValue;
  readonly errorCode?: string;
}

export interface TransactionRepository extends CheckpointRepository, ConfirmationRepository {
  getPlan(id: string): Promise<SyncPlan | undefined>;
  createTransaction(input: TransactionRecord): Promise<TransactionRecord>;
  getTransaction(id: string): Promise<TransactionRecord | undefined>;
  findTransactionByPlan(planId: string, planHash: string): Promise<TransactionRecord | undefined>;
  listRecoverableTransactions(): Promise<readonly TransactionRecord[]>;
  listTransactions(query: TransactionQuery): Promise<Page<TransactionSummary>>;
  nextTransactionSequence(transactionId: string): Promise<number>;
  listTransactionSteps(transactionId: string): Promise<readonly TransactionStep[]>;
  recordTransactionStep(input: TransactionTransition): Promise<TransactionRecord>;
  markTransactionManualReview(
    transactionId: string,
    updatedAt: string,
    errorCode: string,
  ): Promise<TransactionRecord>;
  saveBackupManifest(manifest: BackupManifest): Promise<void>;
  getBackupManifest(transactionId: string): Promise<BackupManifest | undefined>;
  listBackupProtections(): Promise<readonly BackupProtection[]>;
}

export interface CheckpointRepository {
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  getCheckpoint(id: string): Promise<Checkpoint | undefined>;
  listCheckpoints(): Promise<readonly Checkpoint[]>;
}

export interface ConfirmationRepository {
  saveConfirmation(input: StoredConfirmation): Promise<void>;
  getConfirmation(tokenHash: string): Promise<StoredConfirmation | undefined>;
  consumeConfirmation(tokenHash: string, consumedAt: string): Promise<boolean>;
}

export interface ContinuationRepository {
  createContinuationJob(input: ContinuationJob): Promise<ContinuationJob>;
  getContinuationJob(id: string): Promise<ContinuationJob | undefined>;
  findContinuationByRequestHash(requestHash: string): Promise<ContinuationJob | undefined>;
  transitionContinuationJob(id: string, transition: ContinuationTransition): Promise<ContinuationJob>;
  listRecoverableContinuations(): Promise<readonly ContinuationJob[]>;
}

/** Unified read model over source bindings, live projections and old aliases. */
export interface NativeSessionReferenceRepository {
  getReferenceIndex(logicalSessionId: LogicalSessionId): Promise<NativeSessionReferenceIndexV1 | undefined>;
}

export interface CanonicalSessionRepository {
  createCanonicalSession(input: CanonicalSessionRecord): Promise<boolean>;
  getCanonicalSession(id: LogicalSessionId): Promise<CanonicalSessionRecord | undefined>;
  putCanonicalEvent(input: CanonicalEventV1): Promise<boolean>;
  recordDerivation(input: SessionDerivation): Promise<boolean>;
  findDerivationByOperationId(operationId: OperationId): Promise<SessionDerivation | undefined>;
  upsertLogicalWorkspace(input: LogicalWorkspace): Promise<void>;
  setWorkspaceMembership(input: WorkspaceMembership): Promise<void>;
  upsertLogicalProject(input: LogicalProject): Promise<void>;
  replaceProjectRoots(projectId: LogicalProjectId, roots: readonly ProjectRoot[]): Promise<void>;
  setProjectMembership(input: ProjectMembership): Promise<void>;
  saveTombstone(input: SessionTombstone): Promise<void>;
  getTombstone(logicalSessionId: LogicalSessionId): Promise<SessionTombstone | undefined>;
  listChanges(input: import("./canonical.js").CanonicalChangeQuery): Promise<import("./canonical.js").CanonicalChangePage>;
}

export interface ProjectionRunRepository {
  createProjectionRun(input: ProjectionRun): Promise<ProjectionRun>;
  getProjectionRun(id: ProjectionRun["id"]): Promise<ProjectionRun | undefined>;
  setProjectionRunState(id: ProjectionRun["id"], state: ProjectionRunState): Promise<void>;
  upsertProjectionSession(input: ProjectionSession): Promise<void>;
  saveOperationReceipt(input: ProjectionOperationReceipt): Promise<void>;
  getOperationReceipt(operationId: OperationId): Promise<ProjectionOperationReceipt | undefined>;
}

export interface StatusEventRepository {
  appendStatusEvent(input: StatusEventV1): Promise<void>;
  listStatusEvents(query: StatusEventQuery): Promise<Page<StatusEventV1>>;
}

export interface CanonicalProjectionSource {
  load(run: ProjectionRun): Promise<CanonicalProjectionInput>;
  /** Read a pinned immutable body when the live canonical head has advanced. */
  loadVersionEvents?(logicalSessionId: LogicalSessionId, versionId: SessionVersionId): Promise<readonly CanonicalEventV1[]>;
}

export interface IncrementalCanonicalProjectionSource extends CanonicalProjectionSource {
  currentRevision(): Promise<number>;
  listChanges(input: CanonicalChangeQuery): Promise<CanonicalChangePage>;
  loadSessions(run: ProjectionRun, logicalSessionIds: readonly LogicalSessionId[]): Promise<CanonicalProjectionInput>;
}
