import type {
  AdapterProbe,
  ExpectedPlatformState,
  NormalizedSession,
  ObservationHint,
  Page,
  PlatformSessionKey,
  PlatformSessionSummary,
  RegisteredInstance,
  ScanCursor,
  SessionDiff,
  SessionQuery,
  SessionSummary,
  StableObservation,
  BackupManifest,
  PreparedWrite,
  RestoreReceipt,
  TransactionContext,
  UnstableRead,
  VerificationResult,
  VersionGraphPage,
  WriteProbe,
  WriteReceipt,
  InstanceStatus,
  DiscoveryResult,
  EngineStatus,
} from "./model.js";
import type {
  ApplyPlanRequest,
  CreateCheckpointRequest,
  CheckpointRestoreRequest,
  DiffRequest,
  PlanRequest,
  RestoreTransactionRequest,
  ScanRequest,
  SyncPlan,
} from "./plans.js";
import type { Checkpoint, TransactionRecord, TransactionRef } from "./model.js";

export interface SessionReadAdapter {
  readonly platform: "codex" | "dsh";
  probe(instance: RegisteredInstance): Promise<AdapterProbe>;
  list(
    instance: RegisteredInstance,
    cursor?: ScanCursor,
  ): AsyncIterable<PlatformSessionSummary>;
  observe(
    instance: RegisteredInstance,
    key: PlatformSessionKey,
    hint?: ObservationHint,
  ): Promise<StableObservation | UnstableRead>;
  normalize(observation: StableObservation): Promise<NormalizedSession>;
  verify(
    instance: RegisteredInstance,
    key: PlatformSessionKey,
    expected: ExpectedPlatformState,
  ): Promise<VerificationResult>;
}

export interface PrepareWriteRequest {
  readonly plan: SyncPlan;
  readonly instance: RegisteredInstance;
  readonly transaction: TransactionContext;
}

export interface PlatformWriteAdapter {
  readonly platform: "dsh";
  probeWrite(instance: RegisteredInstance): Promise<WriteProbe>;
  prepare(request: PrepareWriteRequest): Promise<PreparedWrite>;
  backup(prepared: PreparedWrite, transaction: TransactionContext): Promise<BackupManifest>;
  commit(prepared: PreparedWrite, transaction: TransactionContext): Promise<WriteReceipt>;
  verify(
    receipt: WriteReceipt,
    expected: ExpectedPlatformState,
  ): Promise<VerificationResult>;
  restore(backup: BackupManifest, transaction: TransactionContext): Promise<RestoreReceipt>;
}

export interface ReadOnlyEngine {
  listInstances(): Promise<readonly InstanceStatus[]>;
  listSessions(query: SessionQuery): Promise<Page<SessionSummary>>;
  getGraph(id: string, cursor?: string): Promise<VersionGraphPage>;
  scan(request: ScanRequest): Promise<DiscoveryResult>;
  diff(request: DiffRequest): Promise<SessionDiff>;
  createPlan(request: PlanRequest): Promise<SyncPlan>;
  getPlan(id: string): Promise<SyncPlan | undefined>;
  status(): Promise<EngineStatus>;
}

export interface WriteEngine extends ReadOnlyEngine {
  applyPlan(request: ApplyPlanRequest): Promise<TransactionRef>;
  getTransaction(id: string): Promise<TransactionRecord | undefined>;
  restoreTransaction(request: RestoreTransactionRequest): Promise<TransactionRef>;
  createCheckpoint(request: CreateCheckpointRequest): Promise<Checkpoint>;
  createCheckpointRestorePlan(request: CheckpointRestoreRequest): Promise<SyncPlan>;
}
