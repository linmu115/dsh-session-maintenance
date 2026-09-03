import {
  CodexReadAdapter,
  isCodexObservationPayload,
  readCodexProjectCatalog,
  resolveCodexProject,
  type CodexProjectOverrides,
  type CodexProjectResolution,
  type CodexReadStatusEvent,
} from "@linmu/dsh-adapter-codex-read";
import type { CanonicalEngineReceipt, CanonicalSessionEngine } from "@linmu/dsh-canonical-session-engine";
import type {
  AdapterEvidencePort,
  AdapterEvidenceRef,
  AdapterId,
  CanonicalEventKind,
  CanonicalEventRole,
  CanonicalEventV1,
  CanonicalOtherContentV1,
  JsonValue,
  LogicalSessionId,
  LogicalWorkspaceId,
  NormalizedEvent,
  RegisteredInstance,
} from "@linmu/dsh-session-contracts";
import { bindingIdFor, canonicalJson, logicalSessionIdFor, sha256Canonical } from "@linmu/dsh-session-domain";

export type CodexCanonicalImportStatusEvent = CodexReadStatusEvent | {
  readonly stage: "canonical.import";
  readonly state: "succeeded" | "retry";
  readonly instanceId: string;
  readonly sessionId: string;
  readonly logicalSessionId: string;
  readonly outcome: CanonicalEngineReceipt["outcome"] | "unstable";
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

function isJsonRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mappedKind(event: NormalizedEvent): CanonicalEventKind {
  if (event.kind === "attachment") return "attachment";
  if (event.kind === "metadata") {
    return isJsonRecord(event.extensions.codexEnvelope) ? "other" : "system-metadata";
  }
  if (event.kind === "tool-import") {
    const tool = event.extensions.codexTool;
    if (isJsonRecord(tool)) {
      if (tool.phase === "call") return "tool-call";
      if (tool.phase === "result") return "tool-result";
    }
    return event.role === "tool" ? "tool-result" : "other";
  }
  if (event.role === "user") return "user-message";
  if (event.role === "assistant") return "assistant-message";
  if (event.role === "system") return "system-message";
  if (event.role === "tool") return "tool-result";
  return "other";
}

function mappedRole(event: NormalizedEvent): CanonicalEventRole {
  return mappedKind(event) === "other" ? "unknown" : event.role;
}

function codexOtherSourceKind(event: NormalizedEvent): string {
  const envelope = isJsonRecord(event.extensions.codexEnvelope)
    ? event.extensions.codexEnvelope
    : undefined;
  const payload = envelope !== undefined && isJsonRecord(envelope.payload)
    ? envelope.payload
    : undefined;
  const envelopeType = typeof envelope?.type === "string" ? envelope.type : "unknown-envelope";
  const payloadType = typeof payload?.type === "string" ? payload.type : undefined;
  return `codex/${envelopeType}${payloadType === undefined ? "" : `:${payloadType}`}`;
}

function codexOtherContent(
  event: NormalizedEvent,
  evidenceRef: AdapterEvidenceRef | null,
): CanonicalOtherContentV1 {
  const sourceKind = codexOtherSourceKind(event);
  return {
    schemaVersion: 1,
    type: "other",
    reason: "unsupported-source-event",
    sourceKind,
    label: "未映射的 Codex 记录",
    summary: `MCSF v1 没有 ${sourceKind} 的公共语义；该记录仅作为维护卡片展示。`,
    evidenceRef,
  };
}

export function canonicalCodexEvent(
  logicalSessionId: LogicalSessionId,
  event: NormalizedEvent,
  evidenceRef: AdapterEvidenceRef | null = null,
): CanonicalEventV1 {
  const kind = mappedKind(event);
  const tool = event.extensions.codexTool;
  const content: JsonValue = kind === "other"
    ? codexOtherContent(event, evidenceRef) as unknown as JsonValue
    : event.kind === "tool-import"
    && isJsonRecord(tool)
    ? {
        callId: typeof tool.callId === "string" ? tool.callId : event.id,
        name: typeof tool.name === "string" ? tool.name : "codex-tool",
        protocol: typeof tool.protocol === "string" ? tool.protocol : "unknown",
        ...(tool.phase === "call"
          ? { arguments: typeof tool.arguments === "string" ? tool.arguments : event.content }
          : { outputText: typeof tool.outputText === "string" ? tool.outputText : event.content }),
      } as JsonValue
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
    role: mappedRole(event),
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
      ...(sourceType === undefined ? {} : { sourceType }),
      ...(event.parentId === null ? {} : { parentEventId: event.parentId }),
    },
  } as unknown as CanonicalEventV1;
}

export class CodexCanonicalImportService {
  private readonly options: CodexCanonicalImportOptions;

  constructor(options: CodexCanonicalImportOptions) {
    this.options = options;
  }

  async sync(input: {
    readonly instance: RegisteredInstance;
    readonly projectOverrides?: CodexProjectOverrides;
    readonly onStatus?: (event: CodexCanonicalImportStatusEvent) => void | Promise<void>;
  }): Promise<CodexCanonicalImportResult> {
    if (input.instance.platform !== "codex") {
      throw new TypeError(`Canonical Codex import requires a Codex instance: ${input.instance.id}`);
    }
    const adapter = new CodexReadAdapter({
      ...(this.options.fixtureGuard === undefined ? {} : { fixtureGuard: this.options.fixtureGuard }),
      ...(input.onStatus === undefined ? {} : { onStatus: input.onStatus }),
    });
    const probe = await adapter.probe(input.instance);
    if (probe.status !== "compatible") {
      throw new Error(`Codex read contract is not compatible: ${input.instance.id}`);
    }
    const projectCatalog = readCodexProjectCatalog(input.instance);
    const summaries: Awaited<ReturnType<CodexReadAdapter["list"]>> extends AsyncIterable<infer T> ? T[] : never[] = [];
    for await (const summary of adapter.list(input.instance)) summaries.push(summary);
    const counts = { scanned: summaries.length, created: 0, advanced: 0, noop: 0, retried: 0 };
    const projectAssignments: Record<CodexProjectResolution["kind"], number> = {
      "thread-project-id": 0,
      "explicit-override": 0,
      "unique-longest-root": 0,
      pending: 0,
      outside: 0,
    };

    for (const summary of summaries) {
      const logicalSessionId = logicalSessionIdFor(summary.key) as LogicalSessionId;
      const observation = await adapter.observe(input.instance, summary.key, summary.hint);
      if (observation.kind === "unstable") {
        counts.retried += 1;
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
      const project = resolveCodexProject(
        observation.payload.thread,
        projectCatalog,
        input.projectOverrides,
      );
      const sourceProjectRoots = projectCatalog.projects
        .find((candidate) => candidate.id === project.projectId)?.roots ?? [];
      const assignment: CodexCanonicalProjectAssignment = {
        logicalSessionId,
        project,
        workspaceId: normalized.workspaceId as LogicalWorkspaceId | null,
        workspacePath: observation.payload.thread.cwd,
        workspaceName: summary.workspaceLabel ?? observation.payload.thread.cwd,
        instanceId: input.instance.id,
        sourceProjectRoots,
        observedAt: normalized.provenance.observedAt,
      };
      await this.options.projectPort.ensureWorkspace(assignment);
      const canonicalEvents: CanonicalEventV1[] = [];
      for (const event of normalized.events) {
        let evidenceRef: AdapterEvidenceRef | null = null;
        if (mappedKind(event) === "other" && this.options.evidencePort !== undefined) {
          const adapterId = probe.contract.adapter as AdapterId;
          const sourceKind = codexOtherSourceKind(event);
          await input.onStatus?.({
            stage: "adapter.evidence",
            state: "started",
            instanceId: input.instance.id,
            sessionId: summary.key.sessionId,
            logicalSessionId,
            adapterId,
            sourceKind,
            evidenceRef: null,
            detail: `persisting ${sha256Canonical(event.extensions as unknown as JsonValue)}`,
          });
          try {
            const record = await this.options.evidencePort.putEvidence({
              schemaVersion: 1,
              adapterId,
              nativeFormatId: probe.contract.schemaFingerprint,
              sourceKind,
              payload: event.extensions as unknown as JsonValue,
              observedAt: normalized.provenance.observedAt,
            });
            evidenceRef = record.ref;
            await input.onStatus?.({
              stage: "adapter.evidence",
              state: "succeeded",
              instanceId: input.instance.id,
              sessionId: summary.key.sessionId,
              logicalSessionId,
              adapterId,
              sourceKind,
              evidenceRef,
              detail: `stored ${record.objectId}`,
            });
          } catch (error) {
            await input.onStatus?.({
              stage: "adapter.evidence",
              state: "failed",
              instanceId: input.instance.id,
              sessionId: summary.key.sessionId,
              logicalSessionId,
              adapterId,
              sourceKind,
              evidenceRef: null,
              detail: error instanceof Error ? error.message.slice(0, 240) : "evidence write failed",
            });
            throw error;
          }
        }
        canonicalEvents.push(canonicalCodexEvent(logicalSessionId, event, evidenceRef));
      }
      const receipt = await this.options.canonicalEngine.observeCodex({
        logicalSessionId,
        title: normalized.title,
        tags: [],
        archivedAt: normalized.archived ? normalized.provenance.observedAt : null,
        workspaceId: normalized.workspaceId as LogicalWorkspaceId | null,
        events: canonicalEvents,
        sourceCursor: canonicalJson(observation.fingerprint as unknown as JsonValue),
        observedAt: normalized.provenance.observedAt,
        authorityBinding: {
          bindingId: bindingIdFor(summary.key),
          key: summary.key,
          adapterContract: probe.contract,
          fingerprint: observation.fingerprint,
        },
      });
      if (receipt.outcome === "created") counts.created += 1;
      else if (receipt.outcome === "advanced") counts.advanced += 1;
      else if (receipt.outcome === "noop") counts.noop += 1;
      await this.options.projectPort.recordAssignment(assignment);
      projectAssignments[project.kind] += 1;
      await input.onStatus?.({
        stage: "canonical.import",
        state: "succeeded",
        instanceId: input.instance.id,
        sessionId: summary.key.sessionId,
        logicalSessionId,
        outcome: receipt.outcome,
        detail: `${receipt.outcome}; project=${project.kind}`,
      });
    }

    return { ...counts, projectAssignments };
  }
}
