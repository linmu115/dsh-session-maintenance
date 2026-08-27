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
  type ResolutionContinuationRequest,
  type SessionRepository,
  type SessionVersionManifest,
} from "@linmu/dsh-session-contracts";
import {
  VersionGraph,
  bindingIdFor,
  canonicalJson,
  classifyHeads,
  normalizeSession,
  sha256Canonical,
} from "@linmu/dsh-session-domain";
import {
  HandoffBuilder,
  HandoffError,
  type HandoffBundle,
  type HandoffRequest,
  type HandoffSource,
} from "@linmu/dsh-session-handoff-context";

type Repository = SessionRepository & ContinuationRepository;

interface PreparedContinuation {
  readonly sources: readonly [HandoffSource] | readonly [HandoffSource, HandoffSource];
  readonly target: CodexContinuationTarget;
  readonly handoff: HandoffRequest;
  readonly resolution?: ResolutionContinuationRequest;
}

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
    const prepared = await this.prepareSingle(request);
    return this.builder.preview(prepared.handoff);
  }

  async create(request: CreateContinuationRequest): Promise<ContinuationJob> {
    return this.createPrepared(request, await this.prepareSingle(request));
  }

  async previewResolution(request: ResolutionContinuationRequest): Promise<ContinuationPreview> {
    const prepared = await this.prepareResolution(request);
    return this.builder.preview(prepared.handoff);
  }

  async createResolution(request: ResolutionContinuationRequest): Promise<ContinuationJob> {
    const prepared = await this.prepareResolution(request);
    return this.createPrepared(prepared.resolution!, prepared);
  }

  private async createPrepared(
    request: CreateContinuationRequest | ResolutionContinuationRequest,
    prepared: PreparedContinuation,
  ): Promise<ContinuationJob> {
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
    const commonVersionId = prepared.resolution === undefined
      ? prepared.sources[0].manifest.id
      : (await this.createResolutionVersion(prepared.resolution, prepared.sources as readonly [HandoffSource, HandoffSource])).id;
    const requestHash = sha256Canonical({
      request,
      sourceHashes: prepared.sources.map((source) => source.manifest.bodyHash),
      target: prepared.target,
      bundleId: bundle.id,
      commonVersionId,
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
      sourceVersionIds: prepared.sources.map((source) => source.manifest.id),
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
      await this.bind(job, prepared.target, probe.schemaFingerprint, created.threadId, commonVersionId);
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
      await this.bind(
        verifying,
        target,
        probe.schemaFingerprint,
        job.codexThreadId,
        await this.commonVersionId(job.request),
      );
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

  private async prepareSingle(request: ContinuationPreviewRequest): Promise<{
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

  private async prepareResolution(request: ResolutionContinuationRequest): Promise<PreparedContinuation> {
    if (request.leftVersionId === request.rightVersionId) {
      throw new SessionMaintenanceError("HANDOFF_REQUEST_INVALID", "Two-parent resolution requires distinct versions");
    }
    const target = this.target(request.targetPresetId);
    const [left, right] = await Promise.all([
      this.loadSource(request.logicalSessionId, request.leftVersionId),
      this.loadSource(request.logicalSessionId, request.rightVersionId),
    ]);
    const graph = await this.loadGraph(request.logicalSessionId);
    const relation = classifyHeads(graph, request.leftVersionId, request.rightVersionId);
    if (relation.kind !== "diverged") {
      throw new SessionMaintenanceError(
        "HANDOFF_REQUEST_INVALID",
        `Two-parent resolution requires diverged versions, received ${relation.kind}`,
      );
    }
    const commonAncestorVersionId = request.commonAncestorVersionId ?? relation.mergeBase;
    if (
      commonAncestorVersionId !== undefined &&
      (!graph.isAncestor(commonAncestorVersionId, request.leftVersionId) ||
        !graph.isAncestor(commonAncestorVersionId, request.rightVersionId))
    ) {
      throw new SessionMaintenanceError(
        "HANDOFF_REQUEST_INVALID",
        "The selected common ancestor is not an ancestor of both resolution parents",
      );
    }
    const resolution: ResolutionContinuationRequest = {
      ...request,
      ...(commonAncestorVersionId === undefined ? {} : { commonAncestorVersionId }),
    };
    const tokenBudget = Math.floor(target.contextWindowTokens * target.inputBudgetRatio);
    return {
      sources: [left, right],
      target,
      resolution,
      handoff: {
        sources: [left, right],
        mode: request.mode,
        tokenBudget,
        resolution: {
          mergeNote: request.mergeNote,
          ...(commonAncestorVersionId === undefined ? {} : { commonAncestorVersionId }),
        },
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

  private async loadGraph(logicalSessionId: string): Promise<VersionGraph> {
    const nodes: SessionVersionManifest[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.repository.getGraphPage(logicalSessionId, cursor);
      nodes.push(...page.nodes);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return new VersionGraph(nodes);
  }

  private async createResolutionVersion(
    request: ResolutionContinuationRequest,
    sources: readonly [HandoffSource, HandoffSource],
  ): Promise<SessionVersionManifest> {
    const [left, right] = sources;
    const resolutionIdentity = {
      type: "two-parent-resolution",
      logicalSessionId: request.logicalSessionId,
      leftVersionId: left.manifest.id,
      rightVersionId: right.manifest.id,
      commonAncestorVersionId: request.commonAncestorVersionId ?? null,
      mergeNote: request.mergeNote,
      sourceBodyHashes: [left.manifest.bodyHash, right.manifest.bodyHash],
    } as const;
    const resolutionHash = sha256Canonical(resolutionIdentity as unknown as JsonValue);
    const observedAt = [left.session.provenance.observedAt, right.session.provenance.observedAt].sort().at(-1)!;
    const session = normalizeSession({
      key: left.session.key,
      title: `Resolution: ${left.session.title}`,
      archived: false,
      workspaceId: left.session.workspaceId ?? right.session.workspaceId,
      provenance: {
        ...left.session.key,
        observedAt,
        sourceVersion: `resolution_${resolutionHash.slice(0, 24)}`,
      },
      compatibility: {
        status: "degraded",
        issues: [{
          code: "TWO_PARENT_RESOLUTION",
          message: "User-confirmed resolution metadata; parent histories remain separate and immutable.",
        }],
      },
      events: [{
        sourceEventId: `resolution-${resolutionHash.slice(0, 24)}`,
        parentSourceEventId: null,
        sequence: 0,
        kind: "metadata",
        role: "system",
        content: request.mergeNote,
        attachments: [],
        extensions: { sessionMaintenanceResolution: resolutionIdentity },
      }],
    });
    const bodyObject = await this.objectStore.put(Buffer.from(canonicalJson(session as unknown as JsonValue)));
    return this.repository.putVersion({
      logicalSessionId: request.logicalSessionId,
      parents: [left.manifest.id, right.manifest.id],
      bodyObject,
      bodyHash: session.bodyHash,
      metadataHash: session.metadataHash,
      source: session.provenance,
      compatibility: session.compatibility,
    });
  }

  private async commonVersionId(
    request: CreateContinuationRequest | ResolutionContinuationRequest,
  ): Promise<string> {
    if ("sourceVersionId" in request) return request.sourceVersionId;
    const prepared = await this.prepareResolution(request);
    return (await this.createResolutionVersion(
      prepared.resolution!,
      prepared.sources as readonly [HandoffSource, HandoffSource],
    )).id;
  }

  private async bind(
    job: ContinuationJob,
    target: CodexContinuationTarget,
    schemaFingerprint: string,
    threadId: string,
    commonVersionId: string,
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
      lastCommonVersionId: commonVersionId,
      status: "read-only",
    };
    const existing = await this.repository.findBinding(key);
    if (existing !== undefined && existing.logicalSessionId !== job.logicalSessionId) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", `Codex thread is bound to another logical session: ${threadId}`);
    }
    await this.repository.bindPlatformSession(binding);
  }
}
