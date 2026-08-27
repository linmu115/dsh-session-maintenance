import type {
  GcPolicy,
  GcReport,
  JsonValue,
  LogicalSession,
  MatchCandidate,
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
  getGraphPage(logicalSessionId: string, cursor?: string): Promise<VersionGraphPage>;
  listReachableObjectIds(): Promise<readonly string[]>;
  savePlan(plan: SyncPlan): Promise<void>;
  getPlan(id: string): Promise<SyncPlan | undefined>;
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
