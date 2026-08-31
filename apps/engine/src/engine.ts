import {
  SessionMaintenanceError,
  normalizedSessionSchema,
  type DiffRequest,
  type DiscoveryResult,
  type EngineStatus,
  type InstanceStatus,
  type NormalizedEvent,
  type NativeMirrorActionPreview,
  type NativeMirrorActionRequest,
  type NativeMirrorRecord,
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
} from "@linmu/dsh-session-contracts";
import type { ContinuationService } from "@linmu/dsh-session-continuation-engine";
import type { NativeMirrorService } from "@linmu/dsh-session-native-mirror-engine";
import type { StatusLog } from "@linmu/dsh-session-status-log";
import type { AdapterRegistry } from "@linmu/dsh-session-adapter-host";
import { readProjectionRuntimeSnapshot, type CanonicalProjectionSource, type ProjectionRuntimeSnapshot } from "@linmu/dsh-session-projection-lifecycle";
import type { ProjectionRunRepository, RunId } from "@linmu/dsh-session-contracts";
import { DiscoveryService, PlanningService, VersionGraph, classifyHeads } from "@linmu/dsh-session-domain";
import { previewCanonicalMigration, type SqliteSessionRepository } from "@linmu/dsh-session-store";

import type { WriteService } from "./write-service.js";

export interface EngineSettingsPort {
  get(): Promise<MaintenanceSettings>;
  patch(input: MaintenanceSettingsPatch): Promise<MaintenanceSettings>;
}

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
  readonly projectionRuntimeRoot: string;
  private readonly discovery: DiscoveryService;
  private lastScanAt: string | undefined;
  private readonly clock: () => string;
  private readonly continuations: ContinuationService;
  private readonly writeService: WriteService | undefined;
  private readonly mirrors: NativeMirrorService;
  private readonly settingsPort: EngineSettingsPort;
  private readonly migrationSourcePath: string;
  private readonly migrationCandidatePath: string;

  constructor(input: {
    readonly instances: readonly RegisteredInstance[];
    readonly adapters: readonly SessionReadAdapter[];
    readonly repository: SqliteSessionRepository;
    readonly objectStore: ContentObjectStore;
    readonly continuations: ContinuationService;
    readonly clock?: () => string;
    readonly writeService?: WriteService;
    readonly mirrors: NativeMirrorService;
    readonly settingsPort?: EngineSettingsPort;
    readonly migrationSourcePath: string;
    readonly migrationCandidatePath: string;
    readonly statusLog: StatusLog;
    readonly adapterRegistry: AdapterRegistry;
    readonly projectionRunRepository: ProjectionRunRepository;
    readonly canonicalProjectionSource: CanonicalProjectionSource;
    readonly projectionRuntimeRoot: string;
  }) {
    this.instances = input.instances;
    this.adapters = input.adapters;
    this.repository = input.repository;
    this.objectStore = input.objectStore;
    this.continuations = input.continuations;
    this.clock = input.clock ?? (() => new Date().toISOString());
    this.discovery = new DiscoveryService(input);
    this.writeService = input.writeService;
    this.mirrors = input.mirrors;
    this.settingsPort = input.settingsPort ?? {
      get: async () => DEFAULT_SETTINGS,
      patch: async (patch) => ({ ...DEFAULT_SETTINGS, ...patch }),
    };
    this.migrationSourcePath = input.migrationSourcePath;
    this.migrationCandidatePath = input.migrationCandidatePath;
    this.statusLog = input.statusLog;
    this.adapterRegistry = input.adapterRegistry;
    this.projectionRunRepository = input.projectionRunRepository;
    this.canonicalProjectionSource = input.canonicalProjectionSource;
    this.projectionRuntimeRoot = input.projectionRuntimeRoot;
  }

  async getProjectionRuntimeSnapshot(runId: RunId): Promise<ProjectionRuntimeSnapshot | undefined> {
    const run = await this.projectionRunRepository.getProjectionRun(runId);
    if (run === undefined || !["preparing", "running", "draining", "verifying"].includes(run.state)) {
      return undefined;
    }
    return readProjectionRuntimeSnapshot(this.projectionRuntimeRoot, runId);
  }

  previewCanonicalMigration(): Promise<CanonicalMigrationPreview> {
    return previewCanonicalMigration({
      database: this.repository.database,
      sourceDatabasePath: this.migrationSourcePath,
      candidateDatabasePath: this.migrationCandidatePath,
    });
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

  listNativeMirrors(): Promise<readonly NativeMirrorRecord[]> { return this.mirrors.list(); }
  getNativeMirror(logicalSessionId: string): Promise<NativeMirrorRecord | undefined> { return this.mirrors.get(logicalSessionId); }
  previewNativeMirrorAction(logicalSessionId: string, request: NativeMirrorActionRequest): Promise<NativeMirrorActionPreview> {
    return this.mirrors.preview(logicalSessionId, request);
  }
  applyNativeMirrorAction(logicalSessionId: string, request: NativeMirrorActionRequest): Promise<NativeMirrorRecord> {
    return this.mirrors.apply(logicalSessionId, request);
  }

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
      if (pair.target.key.platform === "codex") await this.mirrors.requireWritable(request.logicalSessionId);
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
    const result = await this.writer().applyPlan(request);
    if (result.status === "completed") {
      const plan = await this.repository.getPlan(request.planId);
      const targetPlatform = plan?.target?.key.platform ?? (plan?.source.key.platform === "dsh" ? "codex" : "dsh");
      if (plan !== undefined && targetPlatform === "codex") {
        await this.mirrors.recordCompletedTransaction(plan.logicalSessionId, result.id);
      }
    }
    return result;
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
    void this.continuations.close();
    const close = this.repository as SessionRepository & { readonly close?: () => void };
    close.close?.();
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
