import {
  SessionMaintenanceError,
  normalizedSessionSchema,
  type CodexContinuationPort,
  type CodexContinuationTarget,
  type ContentObjectStore,
  type ContinuationJob,
  type ContinuationPreview,
  type ContinuationPreviewRequest,
  type ContinuationRepository,
  type CreateContinuationRequest,
  type JsonValue,
  type PlatformBinding,
  type SessionRepository,
  type SessionVersionManifest,
} from "@linmu/dsh-session-contracts";
import { bindingIdFor, canonicalJson, sha256Canonical } from "@linmu/dsh-session-domain";
import {
  HandoffBuilder,
  HandoffError,
  type HandoffBundle,
  type HandoffRequest,
  type HandoffSource,
} from "@linmu/dsh-session-handoff-context";

type Repository = SessionRepository & ContinuationRepository;

function errorCode(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return fallback;
}

export interface ContinuationServiceOptions {
  readonly repository: Repository;
  readonly objectStore: ContentObjectStore;
  readonly adapter: CodexContinuationPort;
  readonly targets: readonly CodexContinuationTarget[];
  readonly clock?: () => string;
}

export class ContinuationService {
  private readonly repository: Repository;
  private readonly objectStore: ContentObjectStore;
  private readonly adapter: CodexContinuationPort;
  private readonly targets: ReadonlyMap<string, CodexContinuationTarget>;
  private readonly builder = new HandoffBuilder();
  private readonly clock: () => string;

  constructor(options: ContinuationServiceOptions) {
    this.repository = options.repository;
    this.objectStore = options.objectStore;
    this.adapter = options.adapter;
    this.targets = new Map(options.targets.map((target) => [target.id, target]));
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async preview(request: ContinuationPreviewRequest): Promise<ContinuationPreview> {
    const prepared = await this.prepare(request);
    return this.builder.preview(prepared.handoff);
  }

  async create(request: CreateContinuationRequest): Promise<ContinuationJob> {
    const prepared = await this.prepare(request);
    let bundle: HandoffBundle;
    try {
      bundle = this.builder.build(prepared.handoff);
    } catch (error) {
      if (error instanceof HandoffError) {
        throw new SessionMaintenanceError(error.code, error.message, {
          details: error.preview as unknown as JsonValue,
        });
      }
      throw error;
    }
    const requestHash = sha256Canonical({
      request,
      sourceHashes: prepared.sources.map((source) => source.manifest.bodyHash),
      target: prepared.target,
      bundleId: bundle.id,
    } as unknown as JsonValue);
    const existing = await this.repository.findContinuationByRequestHash(requestHash);
    if (existing !== undefined) return existing;
    const handoffObjectId = await this.objectStore.put(Buffer.from(canonicalJson(bundle as unknown as JsonValue)));
    const now = this.clock();
    let job = await this.repository.createContinuationJob({
      id: `continuation_${requestHash.slice(0, 32)}`,
      requestHash,
      request,
      logicalSessionId: request.logicalSessionId,
      sourceVersionIds: [request.sourceVersionId],
      targetPresetId: request.targetPresetId,
      mode: request.mode,
      handoffObjectId,
      status: "prepared",
      createdAt: now,
      updatedAt: now,
    });
    if (job.status !== "prepared") return job;

    const probe = await this.adapter.probe(prepared.target);
    if (probe.status !== "compatible") {
      return this.repository.transitionContinuationJob(job.id, {
        expected: ["prepared"],
        status: "failed",
        errorCode: "ADAPTER_INCOMPATIBLE",
        updatedAt: this.clock(),
      });
    }

    job = await this.repository.transitionContinuationJob(job.id, {
      expected: ["prepared"],
      status: "creating",
      updatedAt: this.clock(),
    });
    try {
      const created = await this.adapter.create({
        prompt: bundle.prompt,
        target: prepared.target,
        onThreadStarted: async (threadId) => {
          job = await this.repository.transitionContinuationJob(job.id, {
            expected: ["creating"],
            status: "started",
            codexThreadId: threadId,
            updatedAt: this.clock(),
          });
        },
      });
      job = await this.repository.transitionContinuationJob(job.id, {
        expected: ["started"],
        status: "verifying",
        codexThreadId: created.threadId,
        codexTurnId: created.turnId,
        updatedAt: this.clock(),
      });
      const verification = await this.adapter.verify(created, prepared.target);
      await this.bind(job, prepared.target, probe.schemaFingerprint, created.threadId);
      return this.repository.transitionContinuationJob(job.id, {
        expected: ["verifying"],
        status: "completed",
        verification: verification as unknown as JsonValue,
        updatedAt: this.clock(),
      });
    } catch (error) {
      const threadId = typeof error === "object" && error !== null && "threadId" in error && typeof error.threadId === "string"
        ? error.threadId
        : job.codexThreadId;
      const current = await this.repository.getContinuationJob(job.id) ?? job;
      return this.repository.transitionContinuationJob(job.id, {
        expected: [current.status],
        status: threadId === undefined ? "failed" : "manual-review",
        ...(threadId === undefined ? {} : { codexThreadId: threadId }),
        errorCode: errorCode(error, threadId === undefined ? "CONTINUATION_CREATE_FAILED" : "CONTINUATION_VERIFY_FAILED"),
        updatedAt: this.clock(),
      });
    }
  }

  get(id: string): Promise<ContinuationJob | undefined> {
    return this.repository.getContinuationJob(id);
  }

  async recover(id: string): Promise<ContinuationJob> {
    const job = await this.repository.getContinuationJob(id);
    if (job === undefined) {
      throw new SessionMaintenanceError("CONTINUATION_NOT_FOUND", `Continuation job not found: ${id}`);
    }
    if (job.status === "completed" || job.status === "failed") return job;
    if (job.codexThreadId === undefined) {
      return this.repository.transitionContinuationJob(job.id, {
        expected: [job.status],
        status: "manual-review",
        errorCode: "CONTINUATION_RECOVERY_REQUIRED",
        updatedAt: this.clock(),
      });
    }
    const target = this.target(job.targetPresetId);
    const probe = await this.adapter.probe(target);
    if (probe.status !== "compatible") {
      return this.repository.transitionContinuationJob(job.id, {
        expected: [job.status],
        status: "manual-review",
        errorCode: "ADAPTER_INCOMPATIBLE",
        updatedAt: this.clock(),
      });
    }
    let verifying = job;
    if (job.status !== "verifying") {
      verifying = await this.repository.transitionContinuationJob(job.id, {
        expected: [job.status],
        status: "verifying",
        updatedAt: this.clock(),
      });
    }
    try {
      const verification = await this.adapter.verify({ threadId: job.codexThreadId }, target);
      await this.bind(verifying, target, probe.schemaFingerprint, job.codexThreadId);
      return this.repository.transitionContinuationJob(job.id, {
        expected: ["verifying"],
        status: "completed",
        verification: verification as unknown as JsonValue,
        updatedAt: this.clock(),
      });
    } catch (error) {
      return this.repository.transitionContinuationJob(job.id, {
        expected: ["verifying"],
        status: "manual-review",
        errorCode: errorCode(error, "CONTINUATION_VERIFY_FAILED"),
        updatedAt: this.clock(),
      });
    }
  }

  close(): Promise<void> {
    return this.adapter.close();
  }

  private async prepare(request: ContinuationPreviewRequest): Promise<{
    readonly sources: readonly [HandoffSource];
    readonly target: CodexContinuationTarget;
    readonly handoff: HandoffRequest;
  }> {
    const target = this.target(request.targetPresetId);
    const source = await this.loadSource(request.logicalSessionId, request.sourceVersionId);
    if (source.session.key.platform !== "dsh") {
      throw new SessionMaintenanceError("HANDOFF_REQUEST_INVALID", "Phase 3 continuation source must be a DSH version");
    }
    const tokenBudget = Math.floor(target.contextWindowTokens * target.inputBudgetRatio);
    return {
      sources: [source],
      target,
      handoff: {
        sources: [source],
        mode: request.mode,
        tokenBudget,
        ...(request.checkpointStartSequence === undefined
          ? {}
          : { checkpointStartSequence: request.checkpointStartSequence }),
      },
    };
  }

  private target(id: string): CodexContinuationTarget {
    const target = this.targets.get(id);
    if (target === undefined) {
      throw new SessionMaintenanceError("HANDOFF_REQUEST_INVALID", `Unknown Codex target preset: ${id}`);
    }
    return target;
  }

  private async loadSource(logicalSessionId: string, versionId: string): Promise<HandoffSource> {
    let cursor: string | undefined;
    let manifest: SessionVersionManifest | undefined;
    do {
      const page = await this.repository.getGraphPage(logicalSessionId, cursor);
      manifest = page.nodes.find((node) => node.id === versionId);
      cursor = page.nextCursor;
    } while (manifest === undefined && cursor !== undefined);
    if (manifest === undefined) {
      throw new SessionMaintenanceError("OBJECT_CORRUPT", `Source version is missing: ${versionId}`);
    }
    const bytes = await this.objectStore.get(manifest.bodyObject);
    const session = normalizedSessionSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    return { manifest, session } as HandoffSource;
  }

  private async bind(
    job: ContinuationJob,
    target: CodexContinuationTarget,
    schemaFingerprint: string,
    threadId: string,
  ): Promise<void> {
    const key = { platform: "codex" as const, instanceId: target.codexInstanceId, sessionId: threadId };
    const binding: PlatformBinding = {
      id: bindingIdFor(key),
      logicalSessionId: job.logicalSessionId,
      key,
      adapterContract: {
        adapter: "codex-continuation",
        platformVersion: target.platformVersion,
        schemaFingerprint,
      },
      lastCommonVersionId: job.sourceVersionIds[0] ?? null,
      status: "read-only",
    };
    const existing = await this.repository.findBinding(key);
    if (existing !== undefined && existing.logicalSessionId !== job.logicalSessionId) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", `Codex thread is bound to another logical session: ${threadId}`);
    }
    await this.repository.bindPlatformSession(binding);
  }
}
