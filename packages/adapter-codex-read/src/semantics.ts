import type {
  CanonicalEventKind,
  CanonicalEventRole,
  CanonicalOtherReason,
  JsonValue,
  NormalizedEvent,
  NormalizedSession,
} from "@linmu/dsh-session-contracts";

export const CODEX_CANONICAL_SEMANTICS_EXTENSION = "codex.canonicalSemantics.v1" as const;

export type CodexCanonicalDisposition = "canonical" | "other";

export type CodexCanonicalSemanticsV1 = Readonly<{
  readonly [key: string]: JsonValue;
  readonly schemaVersion: 1;
  readonly disposition: CodexCanonicalDisposition;
  readonly kind: CanonicalEventKind;
  readonly role: CanonicalEventRole;
  readonly sourceKind: string;
  readonly otherReason: CanonicalOtherReason | null;
}>;

export interface CodexClassificationSummaryV1 {
  readonly schemaVersion: 1;
  readonly sourceEnvelopeCount: number;
  readonly canonicalEventCount: number;
  readonly evidenceOnlyCount: number;
  readonly otherEventCount: number;
  readonly sourceKindCounts: Readonly<Record<string, number>>;
}

export interface CodexNormalizedSession extends NormalizedSession {
  readonly codexClassification: CodexClassificationSummaryV1;
}

export interface CodexCanonicalSemanticsInput {
  readonly disposition: CodexCanonicalDisposition;
  readonly kind: CanonicalEventKind;
  readonly role: CanonicalEventRole;
  readonly sourceKind: string;
  readonly otherReason: CanonicalOtherReason | null;
}

const canonicalKinds = new Set<CanonicalEventKind>([
  "user-message",
  "assistant-message",
  "system-message",
  "reasoning",
  "tool-call",
  "tool-result",
  "annotation",
  "sticker",
  "obsidian-reference",
  "attachment",
  "system-metadata",
  "other",
  "opaque-unknown",
]);
const canonicalRoles = new Set<CanonicalEventRole>(["user", "assistant", "system", "tool", "unknown"]);
const otherReasons = new Set<CanonicalOtherReason>([
  "no-common-semantics",
  "unsupported-source-event",
  "orphan-tool-result",
  "adapter-evidence",
]);

function isRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function codexCanonicalSemantics(
  input: CodexCanonicalSemanticsInput,
): CodexCanonicalSemanticsV1 {
  if (
    input.disposition === "other"
    && (input.kind !== "other" || input.role !== "unknown" || input.otherReason === null)
  ) {
    throw new TypeError("Codex other semantics must map to a reasoned MCSF other event");
  }
  if (input.disposition === "canonical" && (input.kind === "other" || input.otherReason !== null)) {
    throw new TypeError("Codex canonical semantics cannot carry an other reason");
  }
  return { schemaVersion: 1, ...input } as CodexCanonicalSemanticsV1;
}

/** Read one Adapter-owned classification without inspecting the raw Codex envelope. */
export function readCodexCanonicalSemantics(
  event: Pick<NormalizedEvent, "extensions">,
): CodexCanonicalSemanticsV1 {
  const value = event.extensions[CODEX_CANONICAL_SEMANTICS_EXTENSION];
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || (value.disposition !== "canonical" && value.disposition !== "other")
    || typeof value.kind !== "string"
    || !canonicalKinds.has(value.kind as CanonicalEventKind)
    || typeof value.role !== "string"
    || !canonicalRoles.has(value.role as CanonicalEventRole)
    || typeof value.sourceKind !== "string"
    || value.sourceKind.length === 0
    || (value.otherReason !== null
      && (typeof value.otherReason !== "string"
        || !otherReasons.has(value.otherReason as CanonicalOtherReason)))) {
    throw new TypeError(`Normalized Codex event lacks ${CODEX_CANONICAL_SEMANTICS_EXTENSION}`);
  }
  return codexCanonicalSemantics({
    disposition: value.disposition,
    kind: value.kind as CanonicalEventKind,
    role: value.role as CanonicalEventRole,
    sourceKind: value.sourceKind,
    otherReason: value.otherReason as CanonicalOtherReason | null,
  });
}

export function isCodexNormalizedSession(value: NormalizedSession): value is CodexNormalizedSession {
  return "codexClassification" in value;
}
