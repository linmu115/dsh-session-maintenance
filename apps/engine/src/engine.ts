import {
  SessionMaintenanceError,
  normalizedSessionSchema,
  type CodexImportRequest,
  type JsonValue,
  type DiffRequest,
  type DiscoveryResult,
  type EngineStatus,
  type InstanceStatus,
  type NormalizedEvent,
  type NormalizedSession,
  type Page,
  type PlanRequest,
  type PlatformBinding,
  type ReadOnlyEngine,
  type RegisteredInstance,
  type ScanRequest,
  type SessionDiff,
  type SessionQuery,
  type SessionReadAdapter,
  type SessionRepository,
  type SessionSummary,
  type WorkspaceSummary,
  type SyncPlan,
  type VersionGraphPage,
  type ContentObjectStore,
  type ContinuationJob,
  type ContinuationPreview,
  type ContinuationPreviewRequest,
  type CreateContinuationRequest,
  type ResolutionContinuationRequest,
  type ApplyPlanRequest,
  type Checkpoint,
  type CheckpointRestoreRequest,
  type CreateCheckpointRequest,
  type RestoreTransactionRequest,
  type RecoverTransactionRequest,
  type TransactionRecord,
  type TransactionRef,
  type WriteEngine,
  type AdapterDiagnostic,
  type CompatibilityIssue,
  type DashboardOverview,
  type MaintenanceSettings,
  type MaintenanceSettingsPatch,
  type SessionDetail,
  type TransactionDetail,
  type TransactionQuery,
  type TransactionSummary,
  type TransactionRecoveryDecision,
  type VersionContent,
  type IssuedConfirmation,
  type PlanQuery,
  type PlanSummary,
  type PlatformSessionKey,
  type PlatformSessionResolution,
  type CanonicalMigrationPreview,
  type StatusEventQuery,
  type StatusEventV1,
  type AdapterId,
  type DshRuntimeBridgeV1,
  type DshSessionAdapterV1,
  type NativeAppendOperation,
  type NativeSessionId,
  type ProjectionOperationReceipt,
  type RuntimeBrokerAttachRunRequest,
  type RuntimeBrokerAttachedRun,
  type RuntimeBrokerClosedRun,
  type RuntimeBrokerCloseRunRequest,
  type RuntimeBrokerFlushRequest,
  type RuntimeBrokerFlushResponse,
  type RuntimeBrokerPrepareRunRequest,
  type RuntimeBrokerPreparedRun,
  type RuntimeBrokerDrainRunRequest,
  type RuntimeBrokerDrainedRun,
  type RuntimeBrokerRegisterSessionRequest,
  type RuntimeBrokerRegisteredSession,
} from "@linmu/dsh-session-contracts";
import type { CanonicalSessionEngine } from "@linmu/dsh-canonical-session-engine";
import type { ContinuationService } from "@linmu/dsh-session-continuation-engine";
import type { StatusLog } from "@linmu/dsh-session-status-log";
import type { AdapterRegistry } from "@linmu/dsh-session-adapter-host";
import {
  JsonProjectionDirectory,
  projectionRootFor,
  openProjectionRuntimeSessionStream,
  openProjectionRuntimeStream,
  readProjectionRuntimeSnapshot,
  type CanonicalProjectionSource,
  type ProjectionLifecycle,
  type ProjectionRuntimeNdjsonStream,
  type ProjectionRuntimeSnapshot,
} from "@linmu/dsh-session-projection-lifecycle";
import type { ProjectionRunRepository, RunId } from "@linmu/dsh-session-contracts";
import { DiscoveryService, PlanningService, VersionGraph, classifyHeads } from "@linmu/dsh-session-domain";
import {
  MaintenanceWriteCoordinator,
  coordinateAsyncMethods,
  coordinateSyncMethods,
  activateCanonicalMigration,
  previewCanonicalMigration,
  SqliteSessionAliasRepository,
  type CanonicalMigrationActivation,
  type SqliteSessionRepository,
} from "@linmu/dsh-session-store";
import type { StableLogicalReference, StableLogicalReferenceResolution } from "@linmu/dsh-session-contracts";

import { JobRunner } from "./jobs/job-runner.js";
import { JobStore } from "./jobs/job-store.js";
import type { CodexImportService } from "./codex-import-service.js";
import type { RetentionService } from "./retention-service.js";
import type { WriteService } from "./write-service.js";
import { SessionMaintenanceCommands } from "./session-maintenance-commands.js";
import { SessionMaintenanceQueries } from "./session-maintenance-queries.js";
import { ProjectionRuntimeBroker } from "./runtime-broker.js";
import { SqliteRuntimeProjectResolver } from "./runtime-project-resolver.js";

export interface EngineSettingsPort {
  get(): Promise<MaintenanceSettings>;
  patch(input: MaintenanceSettingsPatch): Promise<MaintenanceSettings>;
}

export interface EngineMigrationPort {
  activateDatabaseFile(databaseFile: string): Promise<void>;
}

export type ProjectionLifecycleFactory = (input: {
  readonly adapterId: AdapterId;
  readonly bridge: DshRuntimeBridgeV1;
}) => ProjectionLifecycle;

const DEFAULT_SETTINGS: MaintenanceSettings = {
  codexInstanceId: null,
  dshInstanceId: null,
  workspaceMappingId: null,
  syncSingleSidedTitle: true,
  syncArchive: false,
  scanScope: "current",
  backupRetention: 20,
  allowBatchSafeApply: false,
};

function publicIssues(issues: readonly { readonly code: string }[]): readonly CompatibilityIssue[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: "适配器报告兼容性问题；本机路径与底层细节只保留在 Engine 日志中",
  }));
}

export function transactionRecoveryDecision(
  writeAttached: boolean,
  transaction: TransactionRecord,
  backupHash?: string,
): TransactionRecoveryDecision {
  if (!writeAttached) {
    return { action: "none", allowed: false, confirmationRequired: false, reason: "当前引擎未连接版本锁定的 DSH 写入适配器" };
  }
  if (["prepared", "backing-up", "applying", "verifying", "restoring"].includes(transaction.status)) {
    return {
      action: "recover-interrupted",
      allowed: true,
      confirmationRequired: true,
      reason: "按 journal 重新核对状态；只会验证、恢复备份或转入人工检查",
      ...(backupHash === undefined ? {} : { backupHash }),
    };
  }
  if (transaction.status === "completed" && backupHash !== undefined) {
    return {
      action: "restore-completed",
      allowed: true,
      confirmationRequired: true,
      reason: "显式恢复到本事务写入前的已验证备份",
      backupHash,
    };
  }
  const reason = transaction.status === "restored" ? "事务已经恢复"
    : transaction.status === "restore-failed" ? "上次恢复失败，只允许查看诊断并人工处理"
      : transaction.status === "manual-review" ? "事务已进入人工检查，禁止自动继续"
        : "事务没有可验证的恢复备份";
  return { action: "none", allowed: false, confirmationRequired: false, reason, ...(backupHash === undefined ? {} : { backupHash }) };
}

function semanticEvents(events: readonly NormalizedEvent[]): readonly string[] {
  return events.map((event) => JSON.stringify({
    kind: event.kind,
    role: event.role,
    content: event.content,
    attachments: event.attachments,
  }));
}

function prefix(left: readonly string[], right: readonly string[]): boolean {
  return left.length <= right.length && left.every((value, index) => value === right[index]);
}

export class SessionMaintenanceEngine implements ReadOnlyEngine, WriteEngine {
  readonly instances: readonly RegisteredInstance[];
  readonly adapters: readonly SessionReadAdapter[];
  readonly repository: SqliteSessionRepository;
  readonly objectStore: ContentObjectStore;
  readonly statusLog: StatusLog;
  readonly adapterRegistry: AdapterRegistry;
  readonly projectionRunRepository: ProjectionRunRepository;
  readonly canonicalProjectionSource: CanonicalProjectionSource;
  readonly sessionAliases: SqliteSessionAliasRepository;
  readonly projectionRuntimeRoot: string;
  readonly canonicalEngine: CanonicalSessionEngine;
  readonly projectionLifecycleFactory: ProjectionLifecycleFactory;
  readonly resolveProjectionAdapter: (adapterId: AdapterId) => DshSessionAdapterV1 | undefined;
  readonly runtimeBroker: ProjectionRuntimeBroker;
  readonly sessionCommands: SessionMaintenanceCommands;
  readonly sessionQueries: SessionMaintenanceQueries;
  readonly writes: MaintenanceWriteCoordinator | undefined;
  readonly retention: RetentionService | undefined;
  readonly jobs: JobRunner;
  readonly jobStore: JobStore;
  private readonly codexImports: CodexImportService | undefined;
  private readonly beforeProjectionPrepare: () => Promise<void>;
  private readonly discovery: DiscoveryService;
  private lastScanAt: string | undefined;
  private readonly clock: () => string;
  private readonly continuations: ContinuationService;
  private readonly writeService: WriteService | undefined;
  private readonly settingsPort: EngineSettingsPort;
  private readonly migrationPort: EngineMigrationPort;
  private readonly migrationSourcePath: string;
  private readonly migrationCandidatePath: string;
  private readonly migrationArchivePath: string;

  constructor(input: {
    readonly instances: readonly RegisteredInstance[];
    readonly adapters: readonly SessionReadAdapter[];
    readonly repository: SqliteSessionRepository;
    readonly objectStore: ContentObjectStore;
    readonly continuations: ContinuationService;
    readonly clock?: () => string;
    readonly writeService?: WriteService;
    readonly settingsPort?: EngineSettingsPort;
    readonly migrationPort: EngineMigrationPort;
    readonly migrationSourcePath: string;
    readonly migrationCandidatePath: string;
    readonly migrationArchivePath: string;
    readonly statusLog: StatusLog;
    readonly adapterRegistry: AdapterRegistry;
    readonly projectionRunRepository: ProjectionRunRepository;
    readonly canonicalProjectionSource: CanonicalProjectionSource;
    readonly sessionAliases?: SqliteSessionAliasRepository;
    readonly projectionRuntimeRoot: string;
    readonly canonicalEngine: CanonicalSessionEngine;
    readonly projectionLifecycleFactory: ProjectionLifecycleFactory;
    readonly resolveProjectionAdapter?: (adapterId: AdapterId) => DshSessionAdapterV1 | undefined;
    readonly beforeProjectionPrepare?: () => Promise<void>;
    readonly writes?: MaintenanceWriteCoordinator;
    readonly retention?: RetentionService;
    readonly codexImports?: CodexImportService;
  }) {
    this.writes = input.writes;
    this.retention = input.retention;
    this.codexImports = input.codexImports;
    this.jobStore = new JobStore(input.repository.database);
    if (input.writes !== undefined) coordinateSyncMethods(this.jobStore, ["createScan", "createApply", "createRestore", "createRecover", "createCodexImport", "requestCancellation", "markRunning", "markRequeued", "progress", "complete", "fail"], input.writes, "job-state");
    this.jobs = new JobRunner(this, this.jobStore);
    this.instances = input.instances;
    this.adapters = input.adapters;
    this.repository = input.repository;
    this.objectStore = input.objectStore;
    this.continuations = input.continuations;
    this.clock = input.clock ?? (() => new Date().toISOString());
    this.discovery = new DiscoveryService(input);
    this.writeService = input.writeService;
    this.settingsPort = input.settingsPort ?? {
      get: async () => DEFAULT_SETTINGS,
      patch: async (patch) => ({ ...DEFAULT_SETTINGS, ...patch }),
    };
    this.migrationSourcePath = input.migrationSourcePath;
    this.migrationCandidatePath = input.migrationCandidatePath;
    this.migrationArchivePath = input.migrationArchivePath;
    this.migrationPort = input.migrationPort;
    this.statusLog = input.statusLog;
    this.adapterRegistry = input.adapterRegistry;
    this.projectionRunRepository = input.projectionRunRepository;
    this.sessionQueries = new SessionMaintenanceQueries(input.repository.database);
    this.sessionCommands = new SessionMaintenanceCommands(
      input.repository.database, this.sessionQueries, this.statusLog, this.projectionRunRepository, this.clock,
    );
    this.canonicalProjectionSource = input.canonicalProjectionSource;
    this.sessionAliases = input.sessionAliases
      ?? new SqliteSessionAliasRepository(input.repository.database);
    this.projectionRuntimeRoot = input.projectionRuntimeRoot;
    this.canonicalEngine = input.canonicalEngine;
    this.projectionLifecycleFactory = input.projectionLifecycleFactory;
    this.resolveProjectionAdapter = input.resolveProjectionAdapter ?? (() => undefined);
    this.beforeProjectionPrepare = input.beforeProjectionPrepare ?? (async () => undefined);
    this.runtimeBroker = new ProjectionRuntimeBroker({
      lifecycleFactory: input.projectionLifecycleFactory,
      statusLog: this.statusLog,
      projectResolver: new SqliteRuntimeProjectResolver(input.repository.database),
      selectAdapter: async (request) => (await this.adapterRegistry.select({
        environment: {
          dshVersion: request.dshVersion,
          packageVersions: request.environment.packageVersions,
          runtimeCapabilities: request.environment.runtimeCapabilities,
        },
        ...(request.pinnedAdapterId === null ? {} : { pinnedAdapterId: request.pinnedAdapterId }),
      })).adapterId,
    });
    if (this.writes !== undefined) {
      coordinateAsyncMethods(this.runtimeBroker, ["prepareRun", "attachRun", "append", "registerSession", "flush", "drainRun", "closeRun", "recoverRun"], this.writes, "runtime-lifecycle");
      coordinateSyncMethods(this.sessionCommands, ["restoreSession", "deleteWorkspace"], this.writes, "session-maintenance");
      coordinateAsyncMethods(this.sessionCommands, ["updateSession", "deleteSession", "deleteProjectedSession"], this.writes, "session-maintenance");
      coordinateAsyncMethods(this, ["activateCanonicalMigration", "patchSettings", "issueRestoreConfirmation", "issueRecoveryConfirmation", "createPlan", "applyPlan", "restoreTransaction", "recoverTransaction", "createCheckpoint", "createCheckpointRestorePlan", "previewContinuation", "createContinuation", "previewResolutionContinuation", "createResolutionContinuation", "recoverContinuation", "resolveStableReference"], this.writes, "engine-maintenance");
    }
  }

  runWrite<T>(scope: string, operation: () => T | Promise<T>): Promise<T> {
    return this.writes === undefined ? Promise.resolve().then(operation) : this.writes.run(scope, operation);
  }

  importCodex(request: CodexImportRequest, signal?: AbortSignal, progress?: (current: number, message: string) => void | Promise<void>): Promise<JsonValue> {
    if (this.codexImports === undefined) throw new Error("IMPORT_NOT_AVAILABLE");
    return this.codexImports.run(request, signal, progress);
  }

  async prepareProjectionRuntimeRun(input: RuntimeBrokerPrepareRunRequest): Promise<RuntimeBrokerPreparedRun> {
    await this.beforeProjectionPrepare();
    const instanceIds = this.instances.filter((instance) => instance.platform === "codex").map((instance) => instance.id);
    if (this.codexImports !== undefined && instanceIds.length > 0) {
      const job = await this.runWrite("job-enqueue", () => this.jobs.enqueueCodexImport({ operationId: `titles-${crypto.randomUUID()}`, instanceIds, mode: "titles" }));
      await this.jobs.waitForImport(job.id);
    }
    return this.runtimeBroker.prepareRun(input);
  }

  attachProjectionRuntimeRun(input: RuntimeBrokerAttachRunRequest): Promise<RuntimeBrokerAttachedRun> {
    return this.runtimeBroker.attachRun(input);
  }

  appendProjectionRuntimeEvent(clientId: string, operation: NativeAppendOperation): Promise<ProjectionOperationReceipt> {
    return this.runtimeBroker.append(clientId, operation);
  }

  registerProjectionRuntimeSession(input: RuntimeBrokerRegisterSessionRequest): Promise<RuntimeBrokerRegisteredSession> {
    return this.runtimeBroker.registerSession(input);
  }

  flushProjectionRuntimeSession(input: RuntimeBrokerFlushRequest): Promise<RuntimeBrokerFlushResponse> {
    return this.runtimeBroker.flush(input);
  }

  drainProjectionRuntimeRun(input: RuntimeBrokerDrainRunRequest): Promise<RuntimeBrokerDrainedRun> {
    return this.runtimeBroker.drainRun(input);
  }

  closeProjectionRuntimeRun(input: RuntimeBrokerCloseRunRequest): Promise<RuntimeBrokerClosedRun> {
    return this.runtimeBroker.closeRun(input);
  }

  async getProjectionRuntimeSnapshot(runId: RunId): Promise<ProjectionRuntimeSnapshot | undefined> {
    if (!await this.projectionRunIsReadable(runId)) return undefined;
    return readProjectionRuntimeSnapshot(this.projectionRuntimeRoot, runId);
  }

  async getProjectionRuntimeStream(runId: RunId, hotLimit: number): Promise<ProjectionRuntimeNdjsonStream | undefined> {
    if (!await this.projectionRunIsReadable(runId)) return undefined;
    return openProjectionRuntimeStream(this.projectionRuntimeRoot, runId, hotLimit);
  }

  async getProjectionRuntimeSessionStream(
    runId: RunId,
    nativeSessionId: NativeSessionId,
  ): Promise<ProjectionRuntimeNdjsonStream | undefined> {
    if (!await this.projectionRunIsReadable(runId)) return undefined;
    return openProjectionRuntimeSessionStream(this.projectionRuntimeRoot, runId, nativeSessionId);
  }

  private async projectionRunIsReadable(runId: RunId): Promise<boolean> {
    const run = await this.projectionRunRepository.getProjectionRun(runId);
    return run !== undefined && ["preparing", "running", "draining", "verifying"].includes(run.state);
  }

  async resolveStableReference(input: StableLogicalReference): Promise<StableLogicalReferenceResolution> {
    let resolution = await this.sessionAliases.resolveStableReference(input);
    if (resolution.runId === null) return resolution;
    const run = await this.projectionRunRepository.getProjectionRun(resolution.runId);
    if (run === undefined) return resolution;
    const indexSpan = await this.statusLog.start({
      runId: run.id,
      leaseId: run.leaseId,
      profileId: run.profileId,
      adapterId: run.adapterId,
      dshVersion: run.dshVersion,
      stage: "reference.index",
      logicalSessionId: resolution.logicalSessionId,
      nativeSessionId: resolution.nativeSessionId,
      operationId: null,
      diagnosticDetailRef: `diag:reference-index-${input.referenceType}-${resolution.status}`,
    });
    await this.statusLog.succeed(indexSpan, {
      diagnosticDetailRef: `diag:reference-index-${input.referenceType}-${resolution.status}`,
    });
    const span = await this.statusLog.start({
      runId: run.id,
      leaseId: run.leaseId,
      profileId: run.profileId,
      adapterId: run.adapterId,
      dshVersion: run.dshVersion,
      stage: "reference.roundtrip.verify",
      logicalSessionId: resolution.logicalSessionId,
      nativeSessionId: resolution.nativeSessionId,
      operationId: null,
      diagnosticDetailRef: `diag:reference-${input.referenceType}-${resolution.status}`,
    });
    const adapter = this.resolveProjectionAdapter(run.adapterId);
    if (resolution.logicalSessionId !== null && resolution.status === "resolved"
      && adapter?.manifest.capabilities.includes("verified-anchor-resolution")) {
      try {
        const native = await adapter.resolveReference({
          logicalSessionId: resolution.logicalSessionId,
          logicalAnchorId: input.logicalAnchorId ?? input.legacyNativeAnchorId,
          legacyNativeSessionId: resolution.nativeSessionId,
        }, run, new JsonProjectionDirectory(projectionRootFor(this.projectionRuntimeRoot, run.id)));
        resolution = { ...resolution, ...native, logicalAnchorId: input.logicalAnchorId };
        if (resolution.status !== "resolved") {
          await this.statusLog.fail(span, {
            errorCode: "REFERENCE_ANCHOR_UNAVAILABLE",
            diagnosticDetailRef: `diag:reference-${input.referenceType}-unavailable`,
          });
          return resolution;
        }
      } catch (error) {
        await this.statusLog.fail(span, {
          errorCode: "REFERENCE_RESOLUTION_FAILED",
          diagnosticDetailRef: `diag:reference-resolution-${error instanceof Error ? error.name : "error"}`,
        });
        return { ...resolution, nativeAnchorId: null, status: "unavailable" };
      }
    }
    await this.statusLog.succeed(span, {
      diagnosticDetailRef: `diag:reference-${input.referenceType}-${resolution.status}`,
    });
    return resolution;
  }

  previewCanonicalMigration(): Promise<CanonicalMigrationPreview> {
    return previewCanonicalMigration({
      database: this.repository.database,
      sourceDatabasePath: this.migrationSourcePath,
      candidateDatabasePath: this.migrationCandidatePath,
    });
  }

  async activateCanonicalMigration(expectedSourceDigest: string): Promise<CanonicalMigrationActivation & {
    readonly activeDatabaseFile: string;
    readonly restartRequired: true;
  }> {
    const activation = await activateCanonicalMigration({
      database: this.repository.database,
      sourceDatabasePath: this.migrationSourcePath,
      candidateDatabasePath: this.migrationCandidatePath,
      archiveDatabasePath: this.migrationArchivePath,
      expectedSourceDigest,
    });
    const activeDatabaseFile = this.migrationCandidatePath.slice(
      Math.max(this.migrationCandidatePath.lastIndexOf("/"), this.migrationCandidatePath.lastIndexOf("\\")) + 1,
    );
    await this.migrationPort.activateDatabaseFile(activeDatabaseFile);
    return { ...activation, activeDatabaseFile, restartRequired: true };
  }

  listStatusEvents(query: StatusEventQuery): Promise<Page<StatusEventV1>> {
    return this.statusLog.list(query);
  }

  async listInstances(): Promise<readonly InstanceStatus[]> {
    const byPlatform = new Map(this.adapters.map((adapter) => [adapter.platform, adapter]));
    return Promise.all(this.instances.map(async (instance) => {
      const adapter = byPlatform.get(instance.platform);
      if (adapter === undefined) throw new TypeError(`No adapter for ${instance.platform}`);
      const probe = await adapter.probe(instance);
      return {
        id: instance.id,
        platform: instance.platform,
        displayName: instance.displayName,
        compatibility: { status: probe.status, issues: probe.issues },
      };
    }));
  }

  listSessions(query: SessionQuery): Promise<Page<SessionSummary>> {
    return this.repository.listSessions(query);
  }

  listWorkspaces(): Promise<readonly WorkspaceSummary[]> {
    return this.repository.listWorkspaces();
  }

  getGraph(id: string, cursor?: string): Promise<VersionGraphPage> {
    return this.repository.getGraphPage(id, cursor);
  }

  async getSessionDetail(id: string): Promise<SessionDetail> {
    const summary = await this.repository.getSessionSummary(id);
    if (summary === undefined) throw new SessionMaintenanceError("OBJECT_CORRUPT", `Session is missing: ${id}`);
    const bindings = await this.repository.listBindings(id);
    const heads = (await Promise.all(bindings.map((binding) => this.repository.getObservedHead(binding.id))))
      .filter((head): head is NonNullable<typeof head> => head !== undefined);
    return { summary, bindings, heads };
  }

  async getVersionContent(logicalSessionId: string, versionId: string, maxBytes = 4 * 1024 * 1024): Promise<VersionContent> {
    const manifest = await this.repository.getVersion(versionId);
    if (manifest?.logicalSessionId !== logicalSessionId) {
      throw new SessionMaintenanceError("OBJECT_CORRUPT", `Version is missing: ${versionId}`);
    }
    const bytes = await this.objectStore.get(manifest.bodyObject);
    if (bytes.byteLength > maxBytes) {
      throw new SessionMaintenanceError("CONTENT_TOO_LARGE", `Version content exceeds ${maxBytes} bytes`);
    }
    const session = normalizedSessionSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8"))) as unknown as NormalizedSession;
    return { manifest, session };
  }

  listTransactions(query: TransactionQuery) {
    return this.repository.listTransactions(query);
  }

  async getTransactionDetail(id: string): Promise<TransactionDetail | undefined> {
    const transaction = await this.repository.getTransaction(id);
    if (transaction === undefined) return undefined;
    const backup = await this.repository.getBackupManifest(id);
    return {
      transaction,
      steps: await this.repository.listTransactionSteps(id),
      ...(backup === undefined ? {} : { backup }),
      recovery: transactionRecoveryDecision(this.writeService !== undefined, transaction, backup?.hash),
    };
  }

  listCheckpoints(): Promise<readonly Checkpoint[]> {
    return this.repository.listCheckpoints();
  }

  async listAdapterDiagnostics(): Promise<readonly AdapterDiagnostic[]> {
    const readByPlatform = new Map(this.adapters.map((adapter) => [adapter.platform, adapter]));
    return Promise.all(this.instances.map(async (instance) => {
      const read = readByPlatform.get(instance.platform);
      if (read === undefined) throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", `No read Adapter: ${instance.id}`);
      const readProbe = await read.probe(instance);
      const status: InstanceStatus = {
        id: instance.id,
        platform: instance.platform,
        displayName: instance.displayName,
        compatibility: { status: readProbe.status, issues: publicIssues(readProbe.issues) },
      };
      if (this.writeService === undefined || this.writeService.executor.adapters.get(instance.platform) === undefined) {
        return { instance: status, readContract: readProbe.contract, writeCapabilities: [], writeStatus: "unavailable", issues: publicIssues(readProbe.issues) };
      }
      const write = await this.writeService.probe(instance);
      return {
        instance: status,
        readContract: readProbe.contract,
        writeContract: write.contract,
        writeCapabilities: write.capabilities,
        writeStatus: write.status,
        issues: publicIssues([...readProbe.issues, ...write.issues]),
      };
    }));
  }

  getSettings(): Promise<MaintenanceSettings> { return this.settingsPort.get(); }
  patchSettings(input: MaintenanceSettingsPatch): Promise<MaintenanceSettings> { return this.settingsPort.patch(input); }

  async resolvePlatformSession(key: PlatformSessionKey): Promise<PlatformSessionResolution | undefined> {
    const binding = await this.repository.findBinding(key);
    if (binding === undefined) return undefined;
    const summary = await this.repository.getSessionSummary(binding.logicalSessionId);
    if (summary === undefined) return undefined;
    return {
      logicalSessionId: binding.logicalSessionId,
      bindingId: binding.id,
      title: summary.title,
      status: summary.status,
    };
  }

  async overview(): Promise<DashboardOverview> {
    const page = await this.repository.listSessions({ limit: 100 });
    const unresolved = (await this.repository.listTransactions({ limit: 100 })).items.filter((item) =>
      ["prepared", "backing-up", "applying", "verifying", "restoring", "restore-failed", "manual-review"].includes(item.status),
    ).length;
    return {
      sessions: (await this.repository.counts()).logicalSessions,
      conflicts: page.items.filter((item) => ["diverged", "rewritten", "conflict"].includes(item.status)).length,
      unmapped: page.items.filter((item) => item.status === "unmapped").length,
      unresolvedTransactions: unresolved,
      instances: (await this.listInstances()).map((instance) => ({
        ...instance,
        compatibility: { ...instance.compatibility, issues: publicIssues(instance.compatibility.issues) },
      })),
    };
  }

  async issueRestoreConfirmation(transactionId: string): Promise<IssuedConfirmation> {
    const writer = this.writer();
    const service = writer.executor.confirmationService;
    if (service === undefined) throw new SessionMaintenanceError("CONFIRMATION_REQUIRED", "Confirmation service is unavailable");
    return service.issue(await writer.executor.restoreScope(transactionId));
  }

  async issueRecoveryConfirmation(transactionId: string): Promise<IssuedConfirmation> {
    const writer = this.writer();
    const service = writer.executor.confirmationService;
    if (service === undefined) throw new SessionMaintenanceError("CONFIRMATION_REQUIRED", "Confirmation service is unavailable");
    return service.issue(await writer.recoveryScope(transactionId));
  }

  async scan(request: ScanRequest): Promise<DiscoveryResult> {
    const result = await this.discovery.scanAll(request.instanceIds);
    this.lastScanAt = this.clock();
    return result;
  }

  async diff(request: DiffRequest): Promise<SessionDiff> {
    const pair = await this.resolvePair(request);
    const graphData = await this.repository.getGraph(request.logicalSessionId);
    const relation = classifyHeads(new VersionGraph(graphData.nodes), pair.sourceHead.versionId, pair.targetHead.versionId);
    const source = await this.loadSession(request.logicalSessionId, pair.sourceHead.versionId);
    const target = await this.loadSession(request.logicalSessionId, pair.targetHead.versionId);
    const sourceEvents = semanticEvents(source.events);
    const targetEvents = semanticEvents(target.events);
    const conversation = sourceEvents.length === targetEvents.length && prefix(sourceEvents, targetEvents)
      ? "unchanged"
      : prefix(targetEvents, sourceEvents) || prefix(sourceEvents, targetEvents)
        ? "append-only"
        : "rewritten";
    return {
      relation: relation.kind,
      conversation,
      metadata: source.title === target.title && source.archived === target.archived ? "unchanged" : "metadata-conflict",
      ...(relation.kind === "diverged" ? { mergeBase: relation.mergeBase } : {}),
    };
  }

  async createPlan(request: PlanRequest): Promise<SyncPlan> {
    const pair = await this.resolvePair(request);
    const source = await this.loadSession(request.logicalSessionId, pair.sourceHead.versionId);
    const target = await this.loadSession(request.logicalSessionId, pair.targetHead.versionId);
    const sourceSnapshot = { bindingId: pair.source.id, key: pair.source.key, versionId: pair.sourceHead.versionId, fingerprints: [pair.sourceHead.fingerprint] };
    const targetSnapshot = { bindingId: pair.target.id, key: pair.target.key, versionId: pair.targetHead.versionId, fingerprints: [pair.targetHead.fingerprint] };
    const adapterContracts = [pair.source.adapterContract, pair.target.adapterContract];
    if (this.writeService !== undefined && this.writeService.executor.adapters.get(pair.target.key.platform) !== undefined) {
      const instance = this.instances.find((item) => item.id === pair.target.key.instanceId);
      if (instance === undefined) throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "Plan target instance is unavailable");
      adapterContracts.push((await this.writeService.probe(instance)).contract);
    }
    return new PlanningService(this.repository).create({
      createdAt: request.createdAt,
      logicalSessionId: request.logicalSessionId,
      baseVersionId: pair.targetHead.versionId,
      base: { events: target.events, metadata: { title: target.title, archived: target.archived } },
      source: { snapshot: sourceSnapshot, events: source.events, metadata: { title: source.title, archived: source.archived } },
      target: { kind: "present", head: { snapshot: targetSnapshot, events: target.events, metadata: { title: target.title, archived: target.archived } } },
      adapterContracts,
    });
  }

  getPlan(id: string): Promise<SyncPlan | undefined> {
    return this.repository.getPlan(id);
  }

  listPlans(query: PlanQuery): Promise<Page<PlanSummary>> {
    return this.repository.listPlans(query);
  }

  async applyPlan(request: ApplyPlanRequest): Promise<TransactionRef> {
    return this.writer().applyPlan(request);
  }

  getTransaction(id: string): Promise<TransactionRecord | undefined> {
    return this.writer().getTransaction(id);
  }

  restoreTransaction(request: RestoreTransactionRequest): Promise<TransactionRef> {
    return this.writer().restoreTransaction(request);
  }

  recoverTransaction(request: RecoverTransactionRequest): Promise<TransactionRef> {
    return this.writer().recoverTransaction(request);
  }

  createCheckpoint(request: CreateCheckpointRequest): Promise<Checkpoint> {
    return this.writer().createCheckpoint(request);
  }

  createCheckpointRestorePlan(request: CheckpointRestoreRequest): Promise<SyncPlan> {
    return this.writer().createCheckpointRestorePlan(request);
  }

  status(): Promise<EngineStatus> {
    return Promise.resolve({
      ready: true,
      instanceCount: this.instances.length,
      ...(this.lastScanAt === undefined ? {} : { lastScanAt: this.lastScanAt }),
    });
  }

  previewContinuation(request: ContinuationPreviewRequest): Promise<ContinuationPreview> {
    return this.continuations.preview(request);
  }

  createContinuation(request: CreateContinuationRequest): Promise<ContinuationJob> {
    return this.continuations.create(request);
  }

  previewResolutionContinuation(request: ResolutionContinuationRequest): Promise<ContinuationPreview> {
    return this.continuations.previewResolution(request);
  }

  createResolutionContinuation(request: ResolutionContinuationRequest): Promise<ContinuationJob> {
    return this.continuations.createResolution(request);
  }

  getContinuation(id: string): Promise<ContinuationJob | undefined> {
    return this.continuations.get(id);
  }

  recoverContinuation(id: string): Promise<ContinuationJob> {
    return this.continuations.recover(id);
  }

  close(): void {
    this.writes?.assertIdle();
    void this.continuations.close();
    const close = this.repository as SessionRepository & { readonly close?: () => void };
    close.close?.();
    this.writes?.close();
  }

  private async resolvePair(request: DiffRequest) {
    const bindings = await this.repository.listBindings(request.logicalSessionId);
    const source = request.sourceBindingId === undefined ? bindings[0] : bindings.find((item) => item.id === request.sourceBindingId);
    const target = request.targetBindingId === undefined
      ? bindings.find((item) => item.id !== source?.id)
      : bindings.find((item) => item.id === request.targetBindingId);
    if (source === undefined || target === undefined) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", `Logical session does not have the requested binding pair: ${request.logicalSessionId}`);
    }
    const sourceHead = await this.repository.getObservedHead(source.id);
    const targetHead = await this.repository.getObservedHead(target.id);
    if (sourceHead === undefined || targetHead === undefined) throw new SessionMaintenanceError("OBJECT_CORRUPT", "Binding head is missing");
    return { source, target, sourceHead, targetHead };
  }

  private writer(): WriteService {
    if (this.writeService === undefined) {
      throw new SessionMaintenanceError(
        "CAPABILITY_NOT_AVAILABLE",
        "This composition is read-only; no DSH Core gateway is attached",
      );
    }
    return this.writeService;
  }

  private async loadSession(logicalSessionId: string, versionId: string): Promise<NormalizedSession> {
    let cursor: string | undefined;
    do {
      const page = await this.repository.getGraphPage(logicalSessionId, cursor);
      const manifest = page.nodes.find((node) => node.id === versionId);
      if (manifest !== undefined) {
        const bytes = await this.objectStore.get(manifest.bodyObject);
        return normalizedSessionSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8"))) as unknown as NormalizedSession;
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    throw new SessionMaintenanceError("OBJECT_CORRUPT", `Version is missing: ${versionId}`);
  }

}
