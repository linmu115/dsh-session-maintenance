import type { JsonValue, PlatformKind } from "./model.js";

export const MCSF_SCHEMA_VERSION = 1 as const;

declare const identifierBrand: unique symbol;

export type BrandedId<Name extends string> = string & {
  readonly [identifierBrand]: Name;
};

export type LogicalSessionId = BrandedId<"LogicalSessionId">;
export type SessionVersionId = BrandedId<"SessionVersionId">;
export type LogicalWorkspaceId = BrandedId<"LogicalWorkspaceId">;
export type LogicalProjectId = BrandedId<"LogicalProjectId">;
export type RunId = BrandedId<"RunId">;
export type LeaseId = BrandedId<"LeaseId">;
export type BranchId = BrandedId<"BranchId">;
export type OperationId = BrandedId<"OperationId">;
export type AdapterId = BrandedId<"AdapterId">;
export type AdapterEvidenceRef = BrandedId<"AdapterEvidenceRef">;
export type NativeSessionId = BrandedId<"NativeSessionId">;
export type CheckpointId = BrandedId<"CheckpointId">;
export type StatusEventId = BrandedId<"StatusEventId">;
export type StatusSpanId = BrandedId<"StatusSpanId">;

export type AuthorityScope = "codex" | "maintenance";
export type SessionOriginKind = "codex-mirror" | "maintenance-native" | "codex-derived";
export type SessionDerivationKind = "dsh-continuation";

export type CanonicalEventKind =
  | "user-message"
  | "assistant-message"
  | "system-message"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "annotation"
  | "sticker"
  | "obsidian-reference"
  | "attachment"
  | "system-metadata"
  | "other"
  /** @deprecated Historical pre-MCSF catch-all. New imports must use `other`. */
  | "opaque-unknown";

/**
 * Stable, cross-Harness semantics owned by Maintenance Canonical Session
 * Format v1 (MCSF v1). Native replay details remain Adapter-owned evidence.
 */
export type CanonicalEventSemanticClass =
  | "message"
  | "reasoning"
  | "tool"
  | "reference"
  | "attachment"
  | "metadata"
  | "other";

export type CanonicalEventPresentation = "message" | "tool-card" | "hidden";
export type CanonicalModelExposure = "model-visible" | "log-only";

export interface CanonicalEventProjectionPolicy {
  readonly semanticClass: CanonicalEventSemanticClass;
  readonly presentation: CanonicalEventPresentation;
  readonly modelExposure: CanonicalModelExposure;
}

export type CanonicalOtherReason =
  | "no-common-semantics"
  | "unsupported-source-event"
  | "orphan-tool-result"
  | "adapter-evidence";

/**
 * Portable summary of source data that has no lossless shared meaning.
 * `evidenceRef` points at Adapter-owned evidence when available; it is not a
 * second session truth and must never be expanded into model-facing history.
 */
export interface CanonicalOtherContentV1 {
  readonly schemaVersion: 1;
  readonly type: "other";
  readonly reason: CanonicalOtherReason;
  readonly sourceKind: string;
  readonly label: string;
  readonly summary: string;
  readonly evidenceRef: AdapterEvidenceRef | null;
}

/**
 * MCSF fixes the default exposure policy by semantic kind. Adapters may lose
 * presentation fidelity, but they must never widen `log-only` to model-visible.
 */
export function canonicalEventProjectionPolicy(kind: CanonicalEventKind): CanonicalEventProjectionPolicy {
  switch (kind) {
    case "user-message":
    case "assistant-message":
    case "system-message":
      return { semanticClass: "message", presentation: "message", modelExposure: "model-visible" };
    case "tool-call":
    case "tool-result":
      return { semanticClass: "tool", presentation: "message", modelExposure: "model-visible" };
    case "reasoning":
      return { semanticClass: "reasoning", presentation: "hidden", modelExposure: "log-only" };
    case "annotation":
    case "sticker":
    case "obsidian-reference":
      return { semanticClass: "reference", presentation: "tool-card", modelExposure: "log-only" };
    case "attachment":
      return { semanticClass: "attachment", presentation: "tool-card", modelExposure: "log-only" };
    case "system-metadata":
      return { semanticClass: "metadata", presentation: "hidden", modelExposure: "log-only" };
    case "other":
    case "opaque-unknown":
      return { semanticClass: "other", presentation: "tool-card", modelExposure: "log-only" };
  }
}

export type CanonicalEventRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "unknown";

export interface CanonicalEventSource {
  readonly platform: PlatformKind;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly eventId: string | null;
  readonly cursor: string | null;
}

export interface CanonicalEventV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly logicalSessionId: LogicalSessionId;
  readonly sequence: number;
  readonly kind: CanonicalEventKind;
  readonly role: CanonicalEventRole;
  readonly content: JsonValue;
  readonly source: CanonicalEventSource;
  readonly contentDigest: string;
  readonly rawPayload: JsonValue | null;
  readonly extensions: Readonly<Record<string, JsonValue>>;
}

export interface CanonicalSessionRecord {
  readonly schemaVersion: 1;
  readonly id: LogicalSessionId;
  readonly authorityScope: AuthorityScope;
  readonly originKind: SessionOriginKind;
  readonly headVersionId: SessionVersionId | null;
  readonly title: string;
  readonly tags: readonly string[];
  readonly archivedAt: string | null;
  readonly tombstonedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Lightweight, monotonically ordered reason that a native projection may be stale. */
export type CanonicalChangeKind =
  | "session-created"
  | "content-updated"
  | "metadata-updated"
  | "workspace-updated"
  | "project-updated"
  | "branch-created"
  | "tombstone-updated";

export interface CanonicalChangeV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly logicalSessionId: LogicalSessionId;
  readonly kind: CanonicalChangeKind;
  readonly changedAt: string;
}

export interface CanonicalChangeQuery {
  /** Last revision already applied by the caller. Zero requests the baseline. */
  readonly afterRevision: number;
  /** Bounded raw journal rows. Callers coalesce by logicalSessionId per page. */
  readonly limit: number;
}

export interface CanonicalChangePage {
  readonly schemaVersion: 1;
  readonly afterRevision: number;
  readonly throughRevision: number;
  readonly currentRevision: number;
  readonly hasMore: boolean;
  readonly changes: readonly CanonicalChangeV1[];
}

export interface SessionDerivation {
  readonly schemaVersion: 1;
  readonly childSessionId: LogicalSessionId;
  readonly parentSessionId: LogicalSessionId;
  readonly baseVersionId: SessionVersionId;
  readonly kind: SessionDerivationKind;
  readonly triggerRunId: RunId;
  readonly triggerOperationId: OperationId;
  readonly createdAt: string;
}

export interface LogicalWorkspace {
  readonly schemaVersion: 1;
  readonly id: LogicalWorkspaceId;
  readonly parentId: LogicalWorkspaceId | null;
  readonly name: string;
  readonly sortKey: string;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceMembership {
  readonly schemaVersion: 1;
  readonly logicalSessionId: LogicalSessionId;
  readonly workspaceId: LogicalWorkspaceId | null;
  readonly displayOrder: number;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly revision: number;
}

/** Stable top-level directory identity. Projects group sessions; workspaces remain an independent execution context. */
export interface LogicalProject {
  readonly schemaVersion: 1;
  readonly id: LogicalProjectId;
  readonly name: string;
  readonly sourcePlatform: "codex" | "maintenance";
  readonly sourceProjectId: string | null;
  readonly sortKey: string;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectRoot {
  readonly schemaVersion: 1;
  readonly projectId: LogicalProjectId;
  readonly path: string;
  readonly normalizedPath: string;
  readonly ordinal: number;
}

export interface ProjectMembership {
  readonly schemaVersion: 1;
  readonly logicalSessionId: LogicalSessionId;
  readonly projectId: LogicalProjectId | null;
  readonly revision: number;
}

export interface SessionTombstone {
  readonly schemaVersion: 1;
  readonly logicalSessionId: LogicalSessionId;
  readonly operationId: OperationId;
  readonly checkpointId: CheckpointId;
  readonly previousWorkspaceId: LogicalWorkspaceId | null;
  readonly deletedAt: string;
  readonly retentionUntil: string;
  readonly restoredAt: string | null;
}

export interface StableLogicalReference {
  readonly referenceType: "annotation" | "sticker" | "obsidian-reference";
  readonly logicalSessionId: LogicalSessionId | null;
  readonly logicalAnchorId: string | null;
  readonly legacyNativeSessionId: string | null;
  readonly legacyNativeAnchorId: string | null;
}

export interface StableLogicalReferenceResolution {
  readonly referenceType: "annotation" | "sticker" | "obsidian-reference";
  readonly logicalSessionId: LogicalSessionId | null;
  readonly logicalAnchorId: string | null;
  readonly nativeSessionId: NativeSessionId | null;
  readonly nativeAnchorId: string | null;
  readonly runId: RunId | null;
  readonly status: "resolved" | "unavailable";
}

export type NativeSessionReferenceUse = "source" | "active-projection" | "historical-alias";

/**
 * Read-only native identity associated with one logical MCSF session. It is an
 * index entry only and never owns or duplicates canonical session content.
 */
export interface NativeSessionReferenceV1 {
  readonly schemaVersion: 1;
  readonly logicalSessionId: LogicalSessionId;
  readonly platform: PlatformKind;
  readonly instanceId: string;
  readonly nativeSessionId: NativeSessionId;
  readonly adapterId: AdapterId | null;
  readonly referenceUse: NativeSessionReferenceUse;
  readonly runId: RunId | null;
}

export interface NativeSessionReferenceIndexV1 {
  readonly schemaVersion: 1;
  readonly logicalSessionId: LogicalSessionId;
  readonly references: readonly NativeSessionReferenceV1[];
}
