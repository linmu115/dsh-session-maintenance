import type {
  AdapterId,
  CanonicalEventV1,
  CanonicalSessionRecord,
  LogicalProjectId,
  LogicalSessionId,
  LogicalWorkspace,
  LogicalWorkspaceId,
  NativeSessionId,
  OperationId,
  RunId,
  SessionVersionId,
} from "./canonical.js";
import type { CompatibilityIssue, JsonValue } from "./model.js";
import type { ProjectionOperationReceipt, ProjectionRun } from "./projection.js";

export type AdapterCapability =
  | "session-persistence"
  | "append"
  | "revision-check"
  | "read-from"
  | "borrow-session"
  | "snapshots"
  | "workspace-projection"
  | "annotation"
  | "sticker-obsidian-reference"
  | "unknown-event-round-trip"
  | "stable-native-session-id"
  | "metadata-hot-update"
  | "deep-link-resolution"
  | "recovery"
  | "projection-verification";

export type AdapterVerificationStatus =
  | "verified"
  | "compatible"
  | "experimental"
  | "failed";

export interface AdapterManifestV1 {
  readonly schemaVersion: 1;
  readonly id: AdapterId;
  readonly displayName: string;
  readonly adapterApiVersion: 1;
  readonly packageVersion: string;
  readonly testedDshVersions: readonly string[];
  readonly declaredDshRange: string;
  readonly capabilities: readonly AdapterCapability[];
}

export interface DshEnvironmentDescriptor {
  readonly dshVersion: string;
  readonly packageVersions: Readonly<Record<string, string>>;
  readonly runtimeCapabilities: readonly string[];
}

export interface AdapterProbeResult {
  readonly status: AdapterVerificationStatus;
  readonly manifest: AdapterManifestV1;
  readonly detectedDshVersion: string;
  readonly capabilities: readonly AdapterCapability[];
  readonly issues: readonly CompatibilityIssue[];
}

export interface CanonicalProjectionSessionInput {
  readonly session: CanonicalSessionRecord;
  readonly events: readonly CanonicalEventV1[];
  readonly workspaceId: LogicalWorkspaceId | null;
  /** Stable project grouping identity, distinct from workspace/cwd execution metadata. */
  readonly projectId?: LogicalProjectId | null;
  /** Selected canonical project root; the version adapter may map it to native SessionHeader.cwd. */
  readonly projectRoot?: string | null;
}

export interface CanonicalProjectionInput {
  readonly run: ProjectionRun;
  readonly workspaces: readonly LogicalWorkspace[];
  readonly sessions: readonly CanonicalProjectionSessionInput[];
}

export interface ProjectionManifest {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly adapterId: AdapterId;
  readonly sessionCount: number;
  readonly workspaceCount: number;
  readonly catalogDigest: string;
  readonly sessionDigests: Readonly<Record<string, string>>;
}

export interface NativeAppendOperation {
  readonly runId: RunId;
  readonly operationId: OperationId;
  readonly nativeSessionId: NativeSessionId;
  readonly nativeRevision: number;
  readonly payload: JsonValue;
  readonly observedAt: string;
}

export interface CanonicalAppendOperation {
  readonly runId: RunId;
  readonly operationId: OperationId;
  readonly nativeSessionId: NativeSessionId;
  readonly logicalSessionId: LogicalSessionId;
  readonly baseVersionId: SessionVersionId | null;
  readonly events: readonly CanonicalEventV1[];
  readonly metadata: JsonValue;
}

export interface ProjectionInspection {
  readonly sessionCount: number;
  readonly workspaceCount: number;
  readonly catalogDigest: string;
  readonly sessionDigests: Readonly<Record<string, string>>;
  readonly issues: readonly CompatibilityIssue[];
}

export interface AdapterVerificationResult {
  readonly ok: boolean;
  readonly status: AdapterVerificationStatus;
  readonly issues: readonly CompatibilityIssue[];
}

export interface StableSessionReference {
  readonly logicalSessionId: LogicalSessionId;
  readonly logicalAnchorId: string | null;
  readonly legacyNativeSessionId: string | null;
}

export interface NativeReferenceResolution {
  readonly logicalSessionId: LogicalSessionId;
  readonly nativeSessionId: NativeSessionId | null;
  readonly nativeAnchorId: string | null;
  readonly status: "resolved" | "unavailable";
}

export interface RuntimeAttachContext {
  readonly run: ProjectionRun;
  readonly projectionRoot: string;
  readonly maintenanceEndpoint: string;
}

export interface RuntimeHandle {
  readonly runId: RunId;
  readonly adapterId: AdapterId;
  readonly attachedAt: string;
}

export interface RuntimeDrainResult {
  readonly runId: RunId;
  readonly pendingOperations: number;
  readonly receipts: readonly ProjectionOperationReceipt[];
}

export interface NativeSessionRegistration {
  readonly nativeSessionId: NativeSessionId;
  readonly logicalSessionId: LogicalSessionId;
  readonly header: JsonValue;
  readonly title: string;
  readonly workspaceId: LogicalWorkspaceId | null;
}
