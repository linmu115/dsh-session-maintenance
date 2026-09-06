import {
  SessionMaintenanceError,
  normalizedSessionSchema,
  type ApplyPlanRequest,
  type Checkpoint,
  type CheckpointRestoreCapability,
  type CheckpointRestoreRequest,
  type ContentObjectStore,
  type CreateCheckpointRequest,
  type JsonValue,
  type NormalizedEvent,
  type NormalizedSession,
  type PlatformBinding,
  type RecoverTransactionRequest,
  type RegisteredInstance,
  type RestoreTransactionRequest,
  type SessionReadAdapter,
  type SessionRepository,
  type SyncPlan,
  type TransactionRecord,
  type TransactionRef,
  type TransactionRepository,
  type WriteProbe,
} from "@linmu/dsh-session-contracts";
import {
  bindingIdFor,
  canonicalJson,
  PlanningService,
  validateExecutableDshPlan,
  validateExecutableCodexPlan,
} from "@linmu/dsh-session-domain";
import {
  CheckpointService,
  TransactionExecutor,
  TransactionRecovery,
} from "@linmu/dsh-session-transaction-engine";
import { checkpointRestoreCapability, loadCheckpointRestoreSource } from "./checkpoint-restore-source.js";

type WriteRepository = SessionRepository & TransactionRepository;

export interface WriteServiceOptions {
  readonly repository: WriteRepository;
  readonly objectStore: ContentObjectStore;
  readonly executor: TransactionExecutor;
  readonly instances: ReadonlyMap<string, RegisteredInstance>;
  readonly dshReader?: SessionReadAdapter;
  readonly readers?: ReadonlyMap<"codex" | "dsh", SessionReadAdapter>;
}

function semanticEvent(event: NormalizedEvent): JsonValue {
  return {
    kind: event.kind,
    role: event.role,
    content: event.content,
    attachments: event.attachments.map((attachment) => ({
      name: attachment.name,
      ...(attachment.mediaType === undefined ? {} : { mediaType: attachment.mediaType }),
      source: attachment.source,
    })),
  };
}

function assertSemanticTarget(source: NormalizedSession, target: NormalizedSession): void {
  // DSH persists turn/step/title envelopes that its normalizer intentionally
  // exposes as metadata. They are transport structure, not extra conversation.
  const sourceBody = source.events.filter((event) => event.kind !== "metadata").map(semanticEvent);
  const targetBody = target.events.filter((event) => event.kind !== "metadata").map(semanticEvent);
  if (
    canonicalJson(sourceBody as JsonValue) !== canonicalJson(targetBody as JsonValue) ||
    source.title !== target.title ||
    source.archived !== target.archived
  ) {
    throw new SessionMaintenanceError(
      "VERIFICATION_FAILED",
      "Platform reader did not observe the planned source history and metadata",
    );
  }
}

function isJsonObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function receiptTarget(record: TransactionRecord) {
  const value = record.result;
  if (
    !isJsonObject(value) ||
    !isJsonObject(value.targetKey)
  ) {
    throw new SessionMaintenanceError("OBJECT_CORRUPT", `Completed transaction has no target: ${record.id}`);
  }
  const target = value.targetKey as Readonly<Record<string, JsonValue>>;
  if (
    !["codex", "dsh"].includes(String(target.platform)) ||
    typeof target.instanceId !== "string" ||
    typeof target.sessionId !== "string"
  ) {
    throw new SessionMaintenanceError("OBJECT_CORRUPT", `Completed transaction target is invalid: ${record.id}`);
  }
  return {
    platform: target.platform as "codex" | "dsh",
    instanceId: target.instanceId,
    sessionId: target.sessionId,
  };
}

export class WriteService {
  readonly repository: WriteRepository;
  readonly objectStore: ContentObjectStore;
  readonly executor: TransactionExecutor;
  readonly instances: ReadonlyMap<string, RegisteredInstance>;
  readonly readers: ReadonlyMap<"codex" | "dsh", SessionReadAdapter>;
  private readonly checkpoints: CheckpointService;
  readonly recovery: TransactionRecovery;

  constructor(options: WriteServiceOptions) {
    this.repository = options.repository;
    this.objectStore = options.objectStore;
    this.executor = options.executor;
    this.instances = options.instances;
    this.readers = options.readers ?? new Map(options.dshReader === undefined ? [] : [["dsh", options.dshReader]]);
    this.checkpoints = new CheckpointService(options.repository);
    this.recovery = new TransactionRecovery({
      stateRoot: options.executor.stateRoot,
      repository: options.repository,
      adapters: options.executor.adapters,
      now: options.executor.now,
      lockManager: options.executor.lockManager,
      ...(options.executor.confirmationService === undefined ? {} : { confirmationService: options.executor.confirmationService }),
    });
  }

  async applyPlan(request: ApplyPlanRequest): Promise<TransactionRef> {
    const plan = await this.requiredPlan(request.planId);
    const targetPlatform = plan.target?.key.platform ?? (plan.source.key.platform === "dsh" ? "codex" : "dsh");
    if (targetPlatform === "dsh") validateExecutableDshPlan(plan);
    else validateExecutableCodexPlan(plan);
    const result = await this.executor.apply(request);
    if (result.status !== "completed") return result;

    const transaction = await this.repository.getTransaction(result.id);
    if (transaction?.status !== "completed") {
      throw new SessionMaintenanceError("OBJECT_CORRUPT", `Completed transaction is missing: ${result.id}`);
    }
    await this.verifyAndAdvance(plan, transaction);
    return result;
  }

  getTransaction(id: string): Promise<TransactionRecord | undefined> {
    return this.repository.getTransaction(id);
  }

  restoreTransaction(request: RestoreTransactionRequest): Promise<TransactionRef> {
    return this.executor.restore(request);
  }

  recoveryScope(transactionId: string) {
    return this.recovery.recoveryScope(transactionId);
  }

  recoverTransaction(request: RecoverTransactionRequest): Promise<TransactionRef> {
    return this.recovery.recoverConfirmed(request);
  }

  createCheckpoint(request: CreateCheckpointRequest): Promise<Checkpoint> {
    return this.checkpoints.create(request);
  }

  async createCheckpointRestorePlan(request: CheckpointRestoreRequest): Promise<SyncPlan> {
    const { checkpoint, version, binding, source } = await loadCheckpointRestoreSource(
      this.repository, this.objectStore, request.checkpointId,
    );
    const target = this.instances.get(request.targetInstanceId);
    if (target === undefined || target.platform !== "dsh") {
      throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", `Registered DSH target is missing: ${request.targetInstanceId}`);
    }
    const head = await this.repository.getObservedHead(binding.id);
    const writeProbe = await this.probe(target);
    if (writeProbe.status !== "compatible") {
      throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", `DSH target is not writable: ${target.id}`);
    }
    return new PlanningService(this.repository).create({
      createdAt: request.createdAt,
      logicalSessionId: version.logicalSessionId,
      base: { events: source.events, metadata: { title: source.title, archived: source.archived } },
      source: {
        snapshot: {
          bindingId: binding.id,
          key: binding.key,
          versionId: version.id,
          fingerprints: head?.versionId === version.id ? [head.fingerprint] : [],
        },
        events: source.events,
        metadata: { title: source.title, archived: source.archived },
      },
      target: {
        kind: "missing",
        key: { platform: "dsh", instanceId: target.id, sessionId: `checkpoint-${checkpoint.id}` },
        targetInstanceId: target.id,
        previouslyObserved: false,
      },
      adapterContracts: [binding.adapterContract, writeProbe.contract],
    });
  }

  getCheckpointRestoreCapability(checkpointId: string): Promise<CheckpointRestoreCapability> {
    return checkpointRestoreCapability(this.repository, this.objectStore, checkpointId);
  }

  probe(instance: RegisteredInstance): Promise<WriteProbe> {
    const adapter = this.executor.adapters.get(instance.platform);
    if (adapter === undefined) {
      throw new SessionMaintenanceError("CAPABILITY_NOT_AVAILABLE", `No ${instance.platform} write Adapter is attached`);
    }
    return adapter.probeWrite(instance);
  }

  private async verifyAndAdvance(plan: SyncPlan, transaction: TransactionRecord): Promise<void> {
    const targetKey = receiptTarget(transaction);
    const instance = this.instances.get(targetKey.instanceId);
    if (instance === undefined || instance.platform !== targetKey.platform) {
      throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "Completed platform instance is no longer registered");
    }
    const reader = this.readers.get(targetKey.platform);
    if (reader === undefined) throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", `No ${targetKey.platform} read Adapter is attached`);
    const probe = await reader.probe(instance);
    if (probe.status !== "compatible") {
      throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", `${targetKey.platform} read contract drifted after commit`);
    }
    const observation = await reader.observe(instance, targetKey);
    if (observation.kind === "unstable") {
      throw new SessionMaintenanceError("UNSTABLE_READ", observation.reason);
    }
    const stable = await reader.verify(instance, targetKey, {
      fingerprints: [observation.fingerprint],
    });
    if (!stable.ok) {
      throw new SessionMaintenanceError("PLAN_STALE", `${targetKey.platform} target changed during post-commit verification`);
    }
    const target = await reader.normalize(observation);
    const source = await this.loadVersionBody(plan.source.versionId);
    assertSemanticTarget(source, target);

    const bodyObject = await this.objectStore.put(
      Buffer.from(canonicalJson(target as unknown as JsonValue)),
    );
    const verified = await this.repository.putVersion({
      logicalSessionId: plan.logicalSessionId,
      parents: plan.target === undefined ? [] : [plan.target.versionId],
      bodyObject,
      bodyHash: target.bodyHash,
      metadataHash: target.metadataHash,
      source: target.provenance,
      compatibility: target.compatibility,
    });
    const existingTarget = await this.repository.findBinding(targetKey);
    const targetBinding: PlatformBinding = existingTarget ?? {
      id: bindingIdFor(targetKey),
      logicalSessionId: plan.logicalSessionId,
      key: targetKey,
      adapterContract: probe.contract,
      lastCommonVersionId: plan.baseVersionId ?? null,
      status: "writable",
    };
    if (
      targetBinding.id !== (plan.target?.bindingId ?? targetBinding.id) ||
      targetBinding.logicalSessionId !== plan.logicalSessionId
    ) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", "Verified platform target belongs to another binding");
    }
    await this.repository.advanceVerifiedRefs({
      logicalSessionId: plan.logicalSessionId,
      sourceBindingId: plan.source.bindingId,
      expectedSourceVersionId: plan.source.versionId,
      targetBinding,
      ...(plan.target === undefined ? {} : { expectedTargetVersionId: plan.target.versionId }),
      verifiedHead: {
        bindingId: targetBinding.id,
        versionId: verified.id,
        observedAt: target.provenance.observedAt,
        fingerprint: observation.fingerprint,
      },
      displayTitle: target.title,
      archived: target.archived,
    });
  }

  private async requiredPlan(id: string): Promise<SyncPlan> {
    const plan = await this.repository.getPlan(id);
    if (plan === undefined) throw new SessionMaintenanceError("OBJECT_CORRUPT", `Sync plan not found: ${id}`);
    return plan;
  }

  private async loadVersionBody(versionId: string): Promise<NormalizedSession> {
    const manifest = await this.repository.getVersion(versionId);
    if (manifest === undefined) {
      throw new SessionMaintenanceError("OBJECT_CORRUPT", `Version is missing: ${versionId}`);
    }
    return normalizedSessionSchema.parse(
      JSON.parse(Buffer.from(await this.objectStore.get(manifest.bodyObject)).toString("utf8")),
    ) as unknown as NormalizedSession;
  }
}
