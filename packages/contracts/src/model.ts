export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type PlatformKind = "codex" | "dsh";
/** @deprecated Replaced by canonical authority and origin contracts. */
export type SyncMode = "continuation" | "native-mirror" | "paused";
/** @deprecated Replaced by projection run and derivation states. */
export type NativeMirrorState =
  | "disabled"
  | "initializing"
  | "active"
  | "paused"
  | "busy"
  | "incompatible"
  | "conflicted"
  | "recovering";
export type CompatibilityStatus = "compatible" | "degraded" | "unsupported";
export type BindingStatus = "read-only" | "writable" | "busy" | "incompatible";
export type SessionStatus =
  | "unmapped"
  | "equal"
  | "source-ahead"
  | "target-ahead"
  | "diverged"
  | "rewritten"
  | "conflict"
  | "paused"
  | "unsupported";

export interface PlatformSessionKey {
  readonly platform: PlatformKind;
  readonly instanceId: string;
  readonly sessionId: string;
}

export interface RegisteredInstance {
  readonly id: string;
  readonly platform: PlatformKind;
  readonly displayName: string;
  readonly root: string;
  readonly platformVersion: string;
}

export interface CompatibilityIssue {
  readonly code: string;
  readonly message: string;
  readonly sourceType?: string;
}

export interface CompatibilityReport {
  readonly status: CompatibilityStatus;
  readonly issues: readonly CompatibilityIssue[];
}

export interface AdapterContractRef {
  readonly adapter: string;
  readonly platformVersion: string;
  readonly schemaFingerprint: string;
}

export interface ObservationHint {
  readonly size?: number;
  readonly mtimeNs?: string;
  readonly sourceHash?: string;
  readonly eventCount?: number;
}

export interface StateFingerprint extends PlatformSessionKey {
  readonly kind: "catalog" | "content";
  readonly value: string;
}

export interface ScanCursor {
  readonly opaque: string;
}

export interface PlatformSessionSummary {
  readonly key: PlatformSessionKey;
  readonly title: string;
  readonly archived: boolean;
  readonly workspaceId: string | null;
  readonly workspaceLabel: string | null;
  readonly updatedAt: string;
  readonly hint: ObservationHint;
}

export interface AdapterProbe {
  readonly status: CompatibilityStatus;
  readonly contract: AdapterContractRef;
  readonly capabilities: readonly ("list" | "observe" | "normalize" | "verify-read")[];
  readonly issues: readonly CompatibilityIssue[];
}

export interface StableObservation {
  readonly kind: "stable";
  readonly key: PlatformSessionKey;
  readonly fingerprint: StateFingerprint;
  readonly payload: unknown;
}

export interface UnstableRead {
  readonly kind: "unstable";
  readonly key: PlatformSessionKey;
  readonly reason: string;
  readonly retryable: true;
}

export interface ExpectedPlatformState {
  readonly fingerprints: readonly StateFingerprint[];
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly fingerprints: readonly StateFingerprint[];
  readonly issues: readonly CompatibilityIssue[];
}

export interface Provenance extends PlatformSessionKey {
  readonly observedAt: string;
  readonly sourceVersion?: string;
}

export interface SourceAnchor extends PlatformSessionKey {
  readonly eventId?: string;
  readonly sequence: number;
}

export interface AttachmentRef {
  readonly name: string;
  readonly mediaType?: string;
  readonly source: string;
}

export interface NormalizedEvent {
  readonly id: string;
  readonly parentId: string | null;
  readonly sequence: number;
  readonly kind: "message" | "tool-import" | "attachment" | "metadata";
  readonly role: "user" | "assistant" | "system" | "tool" | "unknown";
  readonly content: string;
  readonly attachments: readonly AttachmentRef[];
  readonly source: SourceAnchor;
  readonly extensions: Readonly<Record<string, JsonValue>>;
}

export interface NormalizedSession {
  readonly schemaVersion: 1;
  readonly key: PlatformSessionKey;
  readonly title: string;
  readonly archived: boolean;
  readonly workspaceId: string | null;
  readonly events: readonly NormalizedEvent[];
  readonly bodyHash: string;
  readonly metadataHash: string;
  readonly provenance: Provenance;
  readonly compatibility: CompatibilityReport;
}

export interface SessionVersionManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly logicalSessionId: string;
  readonly parents: readonly string[];
  readonly bodyObject: string;
  readonly bodyHash: string;
  readonly metadataHash: string;
  readonly source: Provenance;
  readonly compatibility: CompatibilityReport;
}

export interface LogicalSession {
  readonly id: string;
  readonly displayTitle: string;
  readonly canonicalVersionId: string | null;
  readonly syncMode: SyncMode;
  readonly archived: boolean;
  readonly labels: readonly string[];
  readonly createdAt: string;
}

export interface PlatformBinding {
  readonly id: string;
  readonly logicalSessionId: string;
  readonly key: PlatformSessionKey;
  readonly adapterContract: AdapterContractRef;
  readonly lastCommonVersionId: string | null;
  readonly status: BindingStatus;
}

/** @deprecated Replaced by canonical sessions, derivations and projection runs. */
export interface NativeMirrorRecord {
  readonly logicalSessionId: string;
  readonly state: NativeMirrorState;
  readonly codexBindingId: string | null;
  readonly dshBindingId: string | null;
  readonly commonVersionId: string | null;
  readonly codexVersionId: string | null;
  readonly dshVersionId: string | null;
  readonly lastTransactionId: string | null;
  readonly pauseReason: string | null;
  readonly updatedAt: string;
}

export interface MatchCandidate {
  readonly id: string;
  readonly leftBindingId: string;
  readonly rightKey: PlatformSessionKey;
  readonly reason: string;
  readonly confidence: "high" | "low" | "conflict";
  readonly createdAt: string;
  readonly resolvedAt?: string;
}

/** Source compatibility only; target writability still requires a restore preview. */
export interface CheckpointRestoreCapability {
  readonly checkpointId: string;
  readonly supported: boolean;
  readonly reason: string;
}

export interface Checkpoint {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly refs: Readonly<Record<string, string>>;
  readonly backupTransactionIds: readonly string[];
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface VersionNode {
  readonly id: string;
  readonly parents: readonly string[];
}

export interface VersionGraphData {
  readonly nodes: readonly VersionNode[];
}

export type NewVersion = Omit<SessionVersionManifest, "schemaVersion" | "id">;

export interface ObservedHead {
  readonly bindingId: string;
  readonly versionId: string;
  readonly observedAt: string;
  readonly fingerprint: StateFingerprint;
}

export interface RepositoryCounts {
  readonly logicalSessions: number;
  readonly bindings: number;
  readonly versions: number;
  readonly candidates: number;
  readonly plans: number;
}

export interface ObservationRecord {
  readonly logicalSession: LogicalSession;
  readonly binding: PlatformBinding;
  readonly version: SessionVersionManifest;
  readonly head: ObservedHead;
  readonly candidates: readonly MatchCandidate[];
}

export interface RepositoryWriteResult {
  readonly createdLogicalSessions: number;
  readonly createdBindings: number;
  readonly createdVersions: number;
  readonly createdCandidates: number;
}

export interface GcPolicy {
  readonly reachableObjectIds: readonly string[];
  readonly olderThan?: string;
  readonly dryRun: boolean;
}

export interface GcReport {
  readonly reachableObjects: number;
  readonly retainedObjects: number;
  readonly deletedObjects: number;
  readonly deletedBytes: number;
  readonly items: readonly GcItem[];
}

export interface GcItem {
  readonly objectId: string;
  readonly disposition: "retained" | "deletable" | "deleted";
  readonly reason: "reachable" | "retention-window" | "unreachable";
  readonly bytes: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface SessionQuery {
  readonly cursor?: string;
  readonly limit?: number;
  readonly platform?: PlatformKind;
  readonly status?: SessionStatus;
  /** Undefined means every workspace; null means only unclassified sessions. */
  readonly workspaceId?: string | null;
}

export interface WorkspaceRef {
  readonly id: string;
  readonly name: string;
}

export interface SessionSummary {
  readonly logicalSessionId: string;
  readonly title: string;
  readonly archived: boolean;
  readonly platforms: readonly PlatformKind[];
  readonly status: SessionStatus;
  readonly updatedAt: string;
  readonly workspace: WorkspaceRef | null;
}

export interface WorkspaceSummary {
  readonly workspace: WorkspaceRef | null;
  readonly sessionCount: number;
  readonly conflictCount: number;
  readonly unmappedCount: number;
  readonly platforms: readonly PlatformKind[];
  readonly updatedAt: string;
}

export interface VersionGraphPage {
  readonly nodes: readonly SessionVersionManifest[];
  readonly refs: readonly { readonly name: string; readonly versionId: string }[];
  readonly nextCursor?: string;
}

export interface InstanceStatus {
  readonly id: string;
  readonly platform: PlatformKind;
  readonly displayName: string;
  readonly compatibility: CompatibilityReport;
}

export interface DiscoveryResult {
  readonly createdLogicalSessions: number;
  readonly createdBindings: number;
  readonly createdVersions: number;
  readonly createdCandidates: number;
  readonly skippedSessions: number;
  readonly platformWrites: 0;
}

export interface SessionDiff {
  readonly relation: "equal" | "source-ahead" | "target-ahead" | "diverged" | "unrelated";
  readonly conversation: "unchanged" | "append-only" | "rewritten";
  readonly metadata: "unchanged" | "source-only" | "target-only" | "metadata-conflict";
  readonly mergeBase?: string;
}

export interface EngineStatus {
  readonly ready: boolean;
  readonly instanceCount: number;
  readonly lastScanAt?: string;
}

export type WriteCapability =
  | "create-session"
  | "append-events"
  | "update-title"
  | "update-archive"
  | "verify"
  | "restore";

export interface WriteProbe {
  readonly status: CompatibilityStatus;
  readonly contract: AdapterContractRef;
  readonly capabilities: readonly WriteCapability[];
  readonly issues: readonly CompatibilityIssue[];
}

export type TransactionStatus =
  | "prepared"
  | "backing-up"
  | "applying"
  | "verifying"
  | "completed"
  | "restoring"
  | "restored"
  | "restore-failed"
  | "manual-review";

export interface TransactionContext {
  readonly id: string;
  readonly planId: string;
  readonly planHash: string;
  readonly startedAt: string;
}

export interface PreparedWrite {
  readonly id: string;
  readonly planId: string;
  readonly planHash: string;
  readonly platform: PlatformKind;
  readonly instanceId: string;
  readonly rootIdentity: string;
  readonly targetKey?: PlatformSessionKey;
  readonly expected: ExpectedPlatformState;
  readonly payload: JsonValue;
}

export interface BackupManifestEntry {
  readonly logicalName: string;
  readonly objectId: string;
  readonly size: number;
  readonly sha256: string;
  readonly required: boolean;
}

export interface BackupManifest {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly entries: readonly BackupManifestEntry[];
  readonly createdAt: string;
  readonly hash: string;
}

export interface WriteReceipt {
  readonly transactionId: string;
  readonly platform: PlatformKind;
  readonly instanceId: string;
  readonly targetKey?: PlatformSessionKey;
  readonly fingerprints: readonly StateFingerprint[];
  readonly details: JsonValue;
}

export interface RestoreReceipt {
  readonly transactionId: string;
  readonly restored: boolean;
  readonly fingerprints: readonly StateFingerprint[];
  readonly issues: readonly CompatibilityIssue[];
}

export interface TransactionRecord {
  readonly id: string;
  readonly planId: string;
  readonly planHash: string;
  readonly platform: PlatformKind;
  readonly instanceId: string;
  readonly rootIdentity: string;
  readonly adapterContract: AdapterContractRef;
  readonly status: TransactionStatus;
  readonly result?: JsonValue;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TransactionRef {
  readonly id: string;
  readonly status: TransactionStatus;
}

export interface TransactionStep {
  readonly transactionId: string;
  readonly sequence: number;
  readonly status: TransactionStatus;
  readonly step: string;
  readonly data: JsonValue;
  readonly previousHash: string | null;
  readonly entryHash: string;
  readonly at: string;
}

export interface StoredConfirmation {
  readonly tokenHash: string;
  readonly operation: string;
  readonly resourceId: string;
  readonly operationHash: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly consumedAt: string | null;
}

export interface BackupProtection {
  readonly transactionId: string;
  readonly reasons: readonly ("checkpoint" | "unresolved-transaction")[];
}
