import {
  CodexReadAdapter,
  readCodexCanonicalSemantics,
  isCodexObservationPayload,
  readCodexProjectCatalog,
  resolveCodexProject,
  readCodexClassification,
  type CodexProjectOverrides,
  type CodexProjectResolution,
  type CodexNormalizedSession,
  type CodexReadStatusEvent,
} from "@linmu/dsh-adapter-codex-read";
import type { CanonicalEngineReceipt, CanonicalSessionEngine } from "@linmu/dsh-canonical-session-engine";
import { CANONICAL_CONVERSATION_TOPOLOGY_EXTENSION } from "@linmu/dsh-session-contracts";
import type {
  AdapterContractRef,
  AdapterEvidencePort,
  AdapterEvidenceRef,
  AdapterId,
  CanonicalEventV1,
  CanonicalOtherContentV1,
  JsonValue,
  LogicalSessionId,
  LogicalWorkspaceId,
  NormalizedEvent,
  PlatformSessionKey,
  RegisteredInstance,
  StateFingerprint,
} from "@linmu/dsh-session-contracts";
import {
  bindingIdFor,
  canonicalJson,
  logicalSessionIdFor,
  sha256Canonical,
  withPlannedConversationTopology,
} from "@linmu/dsh-session-domain";

export type CodexCanonicalImportStatusEvent = CodexReadStatusEvent | {
  readonly stage: "canonical.import";
  readonly state: "succeeded" | "retry";
  readonly instanceId: string;
  readonly sessionId: string;
  readonly logicalSessionId: string;
  readonly outcome: CanonicalEngineReceipt["outcome"] | "unstable";
  readonly detail: string;
} | {
  readonly stage: "codex.classification" | "codex.topology.plan";
  readonly state: "succeeded";
  readonly instanceId: string;
  readonly sessionId: string;
  readonly logicalSessionId: string;
  readonly detail: string;
} | {
  readonly stage: "adapter.evidence";
  readonly state: "started" | "succeeded" | "failed";
  readonly instanceId: string;
  readonly sessionId: string;
  readonly logicalSessionId: string;
  readonly adapterId: string;
  readonly sourceKind: string;
  readonly evidenceRef: string | null;
  readonly detail: string;
};

export interface CodexCanonicalProjectAssignment {
  readonly logicalSessionId: LogicalSessionId;
  readonly project: CodexProjectResolution;
  readonly workspaceId: LogicalWorkspaceId | null;
  readonly workspacePath: string;
  readonly workspaceName: string;
  readonly instanceId: string;
  readonly sourceProjectRoots: readonly string[];
  readonly observedAt: string;
}

export interface CodexCanonicalProjectPort {
  ensureWorkspace(input: CodexCanonicalProjectAssignment): Promise<void>;
  recordAssignment(input: CodexCanonicalProjectAssignment): Promise<void>;
}

export interface CodexCanonicalImportResult {
  readonly scanned: number;
  readonly created: number;
  readonly advanced: number;
  readonly noop: number;
  readonly retried: number;
  readonly projectAssignments: Readonly<Record<CodexProjectResolution["kind"], number>>;
}

export interface CodexCanonicalImportOptions {
  readonly canonicalEngine: CanonicalSessionEngine;
  readonly projectPort: CodexCanonicalProjectPort;
  readonly evidencePort?: AdapterEvidencePort;
  readonly fixtureGuard?: (root: string) => void;
}

export interface CanonicalImportPlanSessionV1 {
  readonly logicalSessionId: LogicalSessionId;
  readonly sourceSessionId: string;
  readonly normalized: CodexNormalizedSession;
  readonly assignment: CodexCanonicalProjectAssignment;
  readonly sourceCursor: string;
  readonly authorityBinding: {
    readonly bindingId: string;
    readonly key: PlatformSessionKey;
    readonly adapterContract: AdapterContractRef;
    readonly fingerprint: StateFingerprint;
  };
}

/**
 * Immutable, read-only result of observing one Codex catalog. Applying this
 * plan is a separate operation so migrations can validate the source snapshot
 * before touching even a candidate Maintenance database.
 */
export interface CanonicalImportPlanV1 {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly scanned: number;
  readonly retried: number;
  readonly sessions: readonly CanonicalImportPlanSessionV1[];
  readonly projectAssignments: Readonly<Record<CodexProjectResolution["kind"], number>>;
}

export interface CanonicalImportPlanSessionDescriptorV1 {
  readonly logicalSessionId: LogicalSessionId;
  readonly sourceSessionId: string;
  readonly sourceCursor: string;
  readonly normalizedDigest: string;
  readonly assignment: CodexCanonicalProjectAssignment;
}

/** Lightweight plan identity; normalized conversation bodies are visited one at a time. */
export interface CanonicalImportPlanSummaryV1 {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly scanned: number;
  readonly retried: number;
  readonly sessions: readonly CanonicalImportPlanSessionDescriptorV1[];
  readonly projectAssignments: Readonly<Record<CodexProjectResolution["kind"], number>>;
}

function isJsonRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codexOtherContent(
  sourceKind: string,
  reason: CanonicalOtherContentV1["reason"],
  evidenceRef: AdapterEvidenceRef | null,
): CanonicalOtherContentV1 {
  return {
    schemaVersion: 1,
    type: "other",
    reason,
    sourceKind,
    label: "未映射的 Codex 记录",
    summary: `MCSF v1 没有 ${sourceKind} 的公共语义；该记录仅作为维护卡片展示。`,
    evidenceRef,
  };
}

function codexToolContent(
  event: NormalizedEvent,
  kind: "tool-call" | "tool-result",
): JsonValue {
  const tool = event.extensions.codexTool;
  const expectedPhase = kind === "tool-call" ? "call" : "result";
  if (event.kind !== "tool-import" || !isJsonRecord(tool) || tool.phase !== expectedPhase) {
    throw new TypeError(`Normalized Codex ${kind} lacks a matching codexTool payload`);
  }
  if (typeof tool.callId !== "string" || tool.callId.length === 0) {
    throw new TypeError(`Normalized Codex ${kind} lacks an explicit call_id`);
  }
  if (typeof tool.name !== "string" || tool.name.length === 0) {
    throw new TypeError(`Normalized Codex ${kind} lacks a tool name`);
  }
  if (typeof tool.protocol !== "string" || tool.protocol.length === 0) {
    throw new TypeError(`Normalized Codex ${kind} lacks a tool protocol`);
  }
  if (kind === "tool-call") {
    if (typeof tool.arguments !== "string") {
      throw new TypeError("Normalized Codex tool-call lacks arguments");
    }
    return {
      callId: tool.callId,
      name: tool.name,
      protocol: tool.protocol,
      arguments: tool.arguments,
    };
  }
  if (typeof tool.outputText !== "string") {
    throw new TypeError("Normalized Codex tool-result lacks outputText");
  }
  return {
    callId: tool.callId,
    name: tool.name,
    protocol: tool.protocol,
    outputText: tool.outputText,
  };
}

export function canonicalCodexEvent(
  logicalSessionId: LogicalSessionId,
  event: NormalizedEvent,
  evidenceRef: AdapterEvidenceRef | null = null,
): CanonicalEventV1 {
  const semantics = readCodexCanonicalSemantics(event);
  const kind = semantics.kind;
  const content: JsonValue = kind === "other"
    ? codexOtherContent(
        semantics.sourceKind,
        semantics.otherReason ?? "unsupported-source-event",
        evidenceRef,
      ) as unknown as JsonValue
    : kind === "tool-call" || kind === "tool-result"
    ? codexToolContent(event, kind)
    : {
        text: event.content,
        attachments: event.attachments.map((attachment) => ({
          name: attachment.name,
          ...(attachment.mediaType === undefined ? {} : { mediaType: attachment.mediaType }),
          source: attachment.source,
        })),
      } as JsonValue;
  const sourceType = typeof event.extensions.sourceType === "string"
    ? event.extensions.sourceType
    : undefined;
  return {
    schemaVersion: 1,
    id: event.id,
    logicalSessionId,
    sequence: event.sequence,
    kind,
    role: semantics.role,
    content,
    source: {
      platform: event.source.platform,
      instanceId: event.source.instanceId,
      sessionId: event.source.sessionId,
      eventId: event.source.eventId ?? null,
      cursor: String(event.source.sequence),
    },
    contentDigest: sha256Canonical(content),
    rawPayload: null,
    extensions: {
      migratedFrom: "normalized-session-v1",
      normalizedEventKind: event.kind,
      normalizedExtensionsDigest: sha256Canonical(event.extensions as unknown as JsonValue),
      codexSourceKind: semantics.sourceKind,
      ...(sourceType === undefined ? {} : { sourceType }),
      ...(event.parentId === null ? {} : { parentEventId: event.parentId }),
      ...(event.extensions[CANONICAL_CONVERSATION_TOPOLOGY_EXTENSION] === undefined
        ? {}
        : {
            [CANONICAL_CONVERSATION_TOPOLOGY_EXTENSION]:
              event.extensions[CANONICAL_CONVERSATION_TOPOLOGY_EXTENSION],
          }),
    },
  } as unknown as CanonicalEventV1;
}

export async function visitCodexCanonicalImportPlan(input: {
  readonly instance: RegisteredInstance;
  readonly projectOverrides?: CodexProjectOverrides;
  readonly fixtureGuard?: (root: string) => void;
  readonly onStatus?: (event: CodexCanonicalImportStatusEvent) => void | Promise<void>;
  readonly visitSession: (session: CanonicalImportPlanSessionV1) => void | Promise<void>;
}): Promise<CanonicalImportPlanSummaryV1> {
  if (input.instance.platform !== "codex") {
    throw new TypeError(`Canonical Codex import requires a Codex instance: ${input.instance.id}`);
  }
  const adapter = new CodexReadAdapter({
    ...(input.fixtureGuard === undefined ? {} : { fixtureGuard: input.fixtureGuard }),
    ...(input.onStatus === undefined ? {} : { onStatus: input.onStatus }),
  });
  const probe = await adapter.probe(input.instance);
  if (probe.status !== "compatible") {
    throw new Error(`Codex read contract is not compatible: ${input.instance.id}`);
  }
  const projectCatalog = readCodexProjectCatalog(input.instance);
  const summaries: Awaited<ReturnType<CodexReadAdapter["list"]>> extends AsyncIterable<infer T> ? T[] : never[] = [];
  for await (const summary of adapter.list(input.instance)) summaries.push(summary);
  const sessions: CanonicalImportPlanSessionDescriptorV1[] = [];
  const projectAssignments: Record<CodexProjectResolution["kind"], number> = {
    "thread-project-id": 0,
    "explicit-override": 0,
    "unique-longest-root": 0,
    pending: 0,
    outside: 0,
  };
  let retried = 0;

  for (const summary of summaries) {
    const logicalSessionId = logicalSessionIdFor(summary.key) as LogicalSessionId;
    const observation = await adapter.observe(input.instance, summary.key, summary.hint);
    if (observation.kind === "unstable") {
      retried += 1;
      await input.onStatus?.({
        stage: "canonical.import",
        state: "retry",
        instanceId: input.instance.id,
        sessionId: summary.key.sessionId,
        logicalSessionId,
        outcome: "unstable",
        detail: observation.reason,
      });
      continue;
    }
    if (!isCodexObservationPayload(observation.payload)) {
      throw new TypeError(`Codex observation payload drifted: ${summary.key.sessionId}`);
    }
    const normalized = await adapter.normalize(observation);
    const classification = readCodexClassification(normalized);
    await input.onStatus?.({
      stage: "codex.classification",
      state: "succeeded",
      instanceId: input.instance.id,
      sessionId: summary.key.sessionId,
      logicalSessionId,
      detail: [
        `source=${classification.sourceEnvelopeCount}`,
        `canonical=${classification.canonicalEventCount}`,
        `evidenceOnly=${classification.evidenceOnlyCount}`,
        `other=${classification.otherEventCount}`,
        `transportWhitespaceNormalized=${classification.transportWhitespaceNormalizedEventCount}`,
      ].join("; "),
    });
    const project = resolveCodexProject(
      observation.payload.thread,
      projectCatalog,
      input.projectOverrides,
    );
    projectAssignments[project.kind] += 1;
    const item: CanonicalImportPlanSessionV1 = {
      logicalSessionId,
      sourceSessionId: summary.key.sessionId,
      normalized,
      sourceCursor: canonicalJson(observation.fingerprint as unknown as JsonValue),
      assignment: {
        logicalSessionId,
        project,
        workspaceId: normalized.workspaceId as LogicalWorkspaceId | null,
        workspacePath: observation.payload.thread.cwd,
        workspaceName: summary.workspaceLabel ?? observation.payload.thread.cwd,
        instanceId: input.instance.id,
        sourceProjectRoots: projectCatalog.projects
          .find((candidate) => candidate.id === project.projectId)?.roots ?? [],
        observedAt: normalized.provenance.observedAt,
      },
      authorityBinding: {
        bindingId: bindingIdFor(summary.key),
        key: summary.key,
        adapterContract: probe.contract,
        fingerprint: observation.fingerprint,
      },
    };
    await input.visitSession(item);
    sessions.push({
      logicalSessionId,
      sourceSessionId: item.sourceSessionId,
      sourceCursor: item.sourceCursor,
      normalizedDigest: sha256Canonical(item.normalized as unknown as JsonValue),
      assignment: item.assignment,
    });
  }
  return {
    schemaVersion: 1,
    instanceId: input.instance.id,
    scanned: summaries.length,
    retried,
    sessions,
    projectAssignments,
  };
}

export async function buildCodexCanonicalImportPlan(input: {
  readonly instance: RegisteredInstance;
  readonly projectOverrides?: CodexProjectOverrides;
  readonly fixtureGuard?: (root: string) => void;
  readonly onStatus?: (event: CodexCanonicalImportStatusEvent) => void | Promise<void>;
}): Promise<CanonicalImportPlanV1> {
  const sessions: CanonicalImportPlanSessionV1[] = [];
  const summary = await visitCodexCanonicalImportPlan({
    ...input,
    visitSession: (item) => { sessions.push(item); },
  });
  return {
    schemaVersion: 1,
    instanceId: summary.instanceId,
    scanned: summary.scanned,
    retried: summary.retried,
    sessions,
    projectAssignments: summary.projectAssignments,
  };
}

export async function applyCodexCanonicalImportPlan(input: {
  readonly plan: CanonicalImportPlanV1;
  readonly canonicalEngine: CanonicalSessionEngine;
  readonly projectPort: CodexCanonicalProjectPort;
  readonly evidencePort?: AdapterEvidencePort;
  readonly onStatus?: (event: CodexCanonicalImportStatusEvent) => void | Promise<void>;
}): Promise<CodexCanonicalImportResult> {
  const counts = {
    scanned: input.plan.scanned,
    created: 0,
    advanced: 0,
    noop: 0,
    retried: input.plan.retried,
  };
  for (const item of input.plan.sessions) {
    await input.projectPort.ensureWorkspace(item.assignment);
    const canonicalEvents: CanonicalEventV1[] = [];
    for (const event of item.normalized.events) {
      const semantics = readCodexCanonicalSemantics(event);
      let evidenceRef: AdapterEvidenceRef | null = null;
      if (semantics.disposition === "other" && input.evidencePort !== undefined) {
        const adapterId = item.authorityBinding.adapterContract.adapter as AdapterId;
        const sourceKind = semantics.sourceKind;
        await input.onStatus?.({
          stage: "adapter.evidence",
          state: "started",
          instanceId: input.plan.instanceId,
          sessionId: item.sourceSessionId,
          logicalSessionId: item.logicalSessionId,
          adapterId,
          sourceKind,
          evidenceRef: null,
          detail: `persisting ${sha256Canonical(event.extensions as unknown as JsonValue)}`,
        });
        try {
          const record = await input.evidencePort.putEvidence({
            schemaVersion: 1,
            adapterId,
            nativeFormatId: item.authorityBinding.adapterContract.schemaFingerprint,
            sourceKind,
            payload: event.extensions as unknown as JsonValue,
            observedAt: item.normalized.provenance.observedAt,
          });
          evidenceRef = record.ref;
          await input.onStatus?.({
            stage: "adapter.evidence",
            state: "succeeded",
            instanceId: input.plan.instanceId,
            sessionId: item.sourceSessionId,
            logicalSessionId: item.logicalSessionId,
            adapterId,
            sourceKind,
            evidenceRef,
            detail: `stored ${record.objectId}`,
          });
        } catch (error) {
          await input.onStatus?.({
            stage: "adapter.evidence",
            state: "failed",
            instanceId: input.plan.instanceId,
            sessionId: item.sourceSessionId,
            logicalSessionId: item.logicalSessionId,
            adapterId,
            sourceKind,
            evidenceRef: null,
            detail: error instanceof Error ? error.message.slice(0, 240) : "evidence write failed",
          });
          throw error;
        }
      }
      canonicalEvents.push(canonicalCodexEvent(item.logicalSessionId, event, evidenceRef));
    }
    const planned = withPlannedConversationTopology(canonicalEvents);
    const topologyPlan = planned.plan;
    await input.onStatus?.({
      stage: "codex.topology.plan",
      state: "succeeded",
      instanceId: input.plan.instanceId,
      sessionId: item.sourceSessionId,
      logicalSessionId: item.logicalSessionId,
      detail: [
        `events=${topologyPlan.diagnostics.conversationalEventCount}`,
        `turns=${topologyPlan.diagnostics.turnCount}`,
        `steps=${topologyPlan.diagnostics.stepCount}`,
        `matchedTools=${topologyPlan.diagnostics.matchedToolResultCount}`,
        `orphanTools=${topologyPlan.diagnostics.orphanToolResultCount}`,
        `unclosedTools=${topologyPlan.diagnostics.unclosedToolCallCount}`,
        `conflicts=${topologyPlan.diagnostics.topologyConflictCount}`,
      ].join("; "),
    });
    const receipt = await input.canonicalEngine.observeCodex({
      logicalSessionId: item.logicalSessionId,
      title: item.normalized.title,
      tags: [],
      archivedAt: item.normalized.archived ? item.normalized.provenance.observedAt : null,
      workspaceId: item.normalized.workspaceId as LogicalWorkspaceId | null,
      events: planned.events,
      sourceCursor: item.sourceCursor,
      observedAt: item.normalized.provenance.observedAt,
      authorityBinding: item.authorityBinding,
    });
    if (receipt.outcome === "created") counts.created += 1;
    else if (receipt.outcome === "advanced") counts.advanced += 1;
    else if (receipt.outcome === "noop") counts.noop += 1;
    await input.projectPort.recordAssignment(item.assignment);
    await input.onStatus?.({
      stage: "canonical.import",
      state: "succeeded",
      instanceId: input.plan.instanceId,
      sessionId: item.sourceSessionId,
      logicalSessionId: item.logicalSessionId,
      outcome: receipt.outcome,
      detail: `${receipt.outcome}; project=${item.assignment.project.kind}`,
    });
  }
  return { ...counts, projectAssignments: input.plan.projectAssignments };
}

export class CodexCanonicalImportService {
  private readonly options: CodexCanonicalImportOptions;

  constructor(options: CodexCanonicalImportOptions) {
    this.options = options;
  }

  plan(input: {
    readonly instance: RegisteredInstance;
    readonly projectOverrides?: CodexProjectOverrides;
    readonly onStatus?: (event: CodexCanonicalImportStatusEvent) => void | Promise<void>;
  }): Promise<CanonicalImportPlanV1> {
    return buildCodexCanonicalImportPlan({
      ...input,
      ...(this.options.fixtureGuard === undefined ? {} : { fixtureGuard: this.options.fixtureGuard }),
    });
  }

  apply(input: {
    readonly plan: CanonicalImportPlanV1;
    readonly onStatus?: (event: CodexCanonicalImportStatusEvent) => void | Promise<void>;
  }): Promise<CodexCanonicalImportResult> {
    return applyCodexCanonicalImportPlan({
      ...input,
      canonicalEngine: this.options.canonicalEngine,
      projectPort: this.options.projectPort,
      ...(this.options.evidencePort === undefined ? {} : { evidencePort: this.options.evidencePort }),
    });
  }

  async sync(input: {
    readonly instance: RegisteredInstance;
    readonly projectOverrides?: CodexProjectOverrides;
    readonly onStatus?: (event: CodexCanonicalImportStatusEvent) => void | Promise<void>;
  }): Promise<CodexCanonicalImportResult> {
    const counts = { created: 0, advanced: 0, noop: 0 };
    const summary = await visitCodexCanonicalImportPlan({
      ...input,
      ...(this.options.fixtureGuard === undefined ? {} : { fixtureGuard: this.options.fixtureGuard }),
      visitSession: async (item) => {
        const projectAssignments: Record<CodexProjectResolution["kind"], number> = {
          "thread-project-id": 0,
          "explicit-override": 0,
          "unique-longest-root": 0,
          pending: 0,
          outside: 0,
        };
        projectAssignments[item.assignment.project.kind] = 1;
        const applied = await this.apply({
          plan: {
            schemaVersion: 1,
            instanceId: input.instance.id,
            scanned: 1,
            retried: 0,
            sessions: [item],
            projectAssignments,
          },
          ...(input.onStatus === undefined ? {} : { onStatus: input.onStatus }),
        });
        counts.created += applied.created;
        counts.advanced += applied.advanced;
        counts.noop += applied.noop;
      },
    });
    return {
      scanned: summary.scanned,
      retried: summary.retried,
      ...counts,
      projectAssignments: summary.projectAssignments,
    };
  }
}
