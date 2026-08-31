import type { JsonValue, PlatformKind } from "./model.js";

declare const identifierBrand: unique symbol;

export type BrandedId<Name extends string> = string & {
  readonly [identifierBrand]: Name;
};

export type LogicalSessionId = BrandedId<"LogicalSessionId">;
export type SessionVersionId = BrandedId<"SessionVersionId">;
export type LogicalWorkspaceId = BrandedId<"LogicalWorkspaceId">;
export type RunId = BrandedId<"RunId">;
export type LeaseId = BrandedId<"LeaseId">;
export type BranchId = BrandedId<"BranchId">;
export type OperationId = BrandedId<"OperationId">;
export type AdapterId = BrandedId<"AdapterId">;
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
  | "opaque-unknown";

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
