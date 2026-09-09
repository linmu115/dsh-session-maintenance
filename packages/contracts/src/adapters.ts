import type {
  AdapterProbe,
  CheckpointRestoreCapability,
  ExpectedPlatformState,
  NormalizedSession,
  ObservationHint,
  Page,
  PlatformKind,
  PlatformSessionKey,
  PlatformSessionSummary,
  RegisteredInstance,
  ScanCursor,
  SessionDiff,
  SessionQuery,
  SessionSummary,
  WorkspaceSummary,
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
  JsonValue,
} from "./model.js";
import type {
  ApplyPlanRequest,
  CreateCheckpointRequest,
  CheckpointRestoreRequest,
  DiffRequest,
  PlanRequest,
  RecoverTransactionRequest,
  RestoreTransactionRequest,
  ScanRequest,
  SyncPlan,
} from "./plans.js";
import type { Checkpoint, TransactionRecord, TransactionRef } from "./model.js";
import type {
  AdapterEvidencePort,
  AdapterProbeResult,
  CanonicalAppendOperation,
  CanonicalProjectionInput,
  CanonicalProjectionSessionInput,
  DshEnvironmentDescriptor,
  NativeAppendOperation,
  NativeRecoverySession,
  UnmappedNativeRecoverySession,
  NativeSessionRegistration,
  NativeReferenceResolution,
  ProjectionInspection,
  ProjectionManifest,
  RuntimeAttachContext,
  RuntimeDrainResult,
  RuntimeHandle,
  StableSessionReference,
  AdapterVerificationResult,
  AdapterManifestV1,
} from "./adapter-sdk.js";
import type { NativeSessionId, RunId } from "./canonical.js";
import type { ProjectionRun, ProjectionSession } from "./projection.js";

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
  readonly platform: PlatformKind;
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
  getCheckpointRestoreCapability(checkpointId: string): Promise<CheckpointRestoreCapability>;
  listInstances(): Promise<readonly InstanceStatus[]>;
  listSessions(query: SessionQuery): Promise<Page<SessionSummary>>;
  listWorkspaces(): Promise<readonly WorkspaceSummary[]>;
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
  recoverTransaction(request: RecoverTransactionRequest): Promise<TransactionRef>;
  createCheckpoint(request: CreateCheckpointRequest): Promise<Checkpoint>;
  createCheckpointRestorePlan(request: CheckpointRestoreRequest): Promise<SyncPlan>;
}

export interface ProjectionWriter {
  writeWorkspace(nativeWorkspaceId: string, payload: JsonValue): Promise<void>;
  writeSession(nativeSessionId: NativeSessionId, payload: JsonValue): Promise<void>;
}

export interface ProjectionReader {
  listNativeSessionIds(): Promise<readonly NativeSessionId[]>;
  readSession(nativeSessionId: NativeSessionId): Promise<JsonValue>;
}

export interface DshSessionAdapterV1 {
  readonly manifest: AdapterManifestV1;
  /** Optional read-only recovery of known native metadata from exact adapter-owned evidence. */
  restoreNativeEvents?(
    events: readonly import("./canonical.js").CanonicalEventV1[],
    evidence: Pick<AdapterEvidencePort, "readEvidence">,
  ): Promise<readonly import("./canonical.js").CanonicalEventV1[]>;
  probe(environment: DshEnvironmentDescriptor): Promise<AdapterProbeResult>;
  materialize(
    input: CanonicalProjectionInput,
    output: ProjectionWriter,
  ): Promise<ProjectionManifest>;
  /** Rebuilds a full manifest from cached digests without rereading session bodies. */
  composeProjectionManifest?(
    input: import("./adapter-sdk.js").ProjectionManifestCompositionInput,
  ): ProjectionManifest;
  normalizeAppend(
    operation: NativeAppendOperation,
    evidencePort?: AdapterEvidencePort,
  ): Promise<CanonicalAppendOperation>;
  inspect(projection: ProjectionReader): Promise<ProjectionInspection>;
  verify(
    expected: ProjectionManifest,
    actual: ProjectionInspection,
  ): Promise<AdapterVerificationResult>;
  resolveReference(
    reference: StableSessionReference,
    run: ProjectionRun,
    /** Read only the requested session; aliases never enter model-facing events. */
    projection?: ProjectionReader,
  ): Promise<NativeReferenceResolution>;
  /**
   * Returns the native revision represented by the canonical prefix in one
   * materialized payload. Implementations must validate that the payload begins
   * with the canonical session; a divergent prefix must throw.
   */
  projectedNativeRevision?(
    canonical: CanonicalProjectionSessionInput,
    payload: JsonValue,
  ): number;
  /** Decodes adapter-owned projection metadata during crash recovery. */
  recoverProjectionSession?(
    projection: ProjectionSession,
    payload: JsonValue,
  ): NativeRecoverySession;
  /** Recovers only a payload left by an interrupted native-session registration. */
  recoverUnmappedProjectionSession?(
    runId: RunId,
    nativeSessionId: NativeSessionId,
    payload: JsonValue,
  ): UnmappedNativeRecoverySession;
  /**
   * Identifies a pending crash-recovery WAL append that contains only native
   * runtime preparation state and therefore has no canonical user mutation to
   * replay. Returning true preserves the WAL as a superseded recovery artifact
   * instead of committing it as a new logical-session version.
   */
  shouldSupersedeRecoveryAppend?(operation: NativeAppendOperation): boolean;
}

export interface DshRuntimeBridgeV1 {
  attach(context: RuntimeAttachContext): Promise<RuntimeHandle>;
  drain(handle: RuntimeHandle): Promise<RuntimeDrainResult>;
  drainSession?(handle: RuntimeHandle, nativeSessionId: NativeSessionId): Promise<RuntimeDrainResult>;
  /** Removes one native session from an attached temporary projection after pending writes drain. */
  hideSession?(handle: RuntimeHandle, nativeSessionId: NativeSessionId): Promise<void>;
  detach(handle: RuntimeHandle): Promise<void>;
  registerSession?(
    handle: RuntimeHandle,
    registration: NativeSessionRegistration,
    projection: unknown,
  ): Promise<void>;
}
