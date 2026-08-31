import type {
  Checkpoint,
  EngineStatus,
  Page,
  SessionSummary,
  WorkspaceSummary,
  TransactionRecord,
  NormalizedSession,
  PlatformBinding,
  ObservedHead,
  SessionVersionManifest,
  VersionGraphPage,
} from "./model.js";
import type {
  AdapterDiagnostic,
  DashboardOverview,
  MaintenanceSettings,
  TransactionDetail,
  TransactionSummary,
  DashboardLaunchInfo,
  DashboardUiSession,
  PlatformSessionResolution,
} from "./operations.js";
import type { JobRef } from "./jobs.js";
import type { SyncPlan } from "./plans.js";
import type { StatusEventState, StatusEventV1, StatusStage } from "./status.js";
import type { AdapterManifestV1, AdapterProbeResult } from "./adapter-sdk.js";
import type { ProjectionRun, ProjectionSessionMode } from "./projection.js";
import type {
  CanonicalEventV1,
  CanonicalSessionRecord,
  LogicalWorkspace,
  SessionDerivation,
  WorkspaceMembership,
} from "./canonical.js";

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
}

export interface ApiErrorResponse {
  readonly error: ApiErrorBody;
}

export interface EngineStatusResponse {
  readonly status: EngineStatus;
}

export interface SessionListResponse {
  readonly page: Page<SessionSummary>;
}

export interface WorkspaceListResponse {
  readonly workspaces: readonly WorkspaceSummary[];
}

export interface VersionGraphResponse {
  readonly graph: VersionGraphPage;
}

export interface PlanResponse {
  readonly plan: SyncPlan;
}

export interface JobAcceptedResponse {
  readonly job: JobRef;
}

export interface TransactionResponse {
  readonly transaction: TransactionRecord;
}

export interface CheckpointResponse {
  readonly checkpoint: Checkpoint;
}

export interface SessionDetailResponse {
  readonly session: {
    readonly summary: SessionSummary;
    readonly bindings: readonly PlatformBinding[];
    readonly heads: readonly ObservedHead[];
  };
}

export interface VersionContentResponse {
  readonly version: { readonly manifest: SessionVersionManifest; readonly session: NormalizedSession };
}

export interface TransactionListResponse { readonly page: Page<TransactionSummary> }
export interface TransactionDetailResponse { readonly detail: TransactionDetail }
export interface CheckpointListApiResponse { readonly checkpoints: readonly Checkpoint[] }
export interface DiagnosticsResponse { readonly diagnostics: readonly AdapterDiagnostic[] }
export interface SettingsResponse { readonly settings: MaintenanceSettings }
export interface OverviewResponse { readonly overview: DashboardOverview }
export interface DashboardLaunchResponse { readonly launch: DashboardLaunchInfo }
export interface DashboardUiSessionResponse { readonly session: DashboardUiSession }
export interface PlatformSessionResolutionResponse { readonly resolution: PlatformSessionResolution }
export interface ProjectionRunResponse { readonly run: ProjectionRun }
export interface StatusEventListResponse { readonly page: Page<StatusEventV1> }
export interface AdapterManifestResponse { readonly manifest: AdapterManifestV1 }

export type CanonicalMigrationDisposition =
  | "codex-mirror"
  | "maintenance-native"
  | "codex-mirror-with-derived-child"
  | "review-required"
  | "unclassified";

export interface CanonicalMigrationSourceFile {
  readonly path: string;
  readonly digest: string;
  readonly size: number;
}

export interface CanonicalMigrationClassification {
  readonly logicalSessionId: string;
  readonly disposition: CanonicalMigrationDisposition;
  readonly reasonCode:
    | "CODEX_ONLY"
    | "DSH_ONLY"
    | "MIRROR_EQUAL"
    | "CODEX_AHEAD"
    | "DSH_AHEAD_DERIVE"
    | "DIVERGED_REQUIRES_REVIEW"
    | "NO_NATIVE_MIRROR"
    | "INCOMPLETE_MIRROR_STATE";
  readonly proposedSessionIds: readonly string[];
  readonly workspaceIds: readonly string[];
}

export interface CanonicalMigrationPreview {
  readonly sourceSchemaVersion: number;
  readonly sourceDigest: string;
  readonly sourceFiles: readonly CanonicalMigrationSourceFile[];
  readonly candidate: {
    readonly path: string;
    readonly exists: boolean;
    readonly created: false;
  };
  readonly rollback: {
    readonly sourcePreserved: true;
    readonly activationRequired: true;
    readonly strategy: "candidate-copy-and-pointer-swap";
  };
  readonly counts: {
    readonly sourceLogicalSessions: number;
    readonly codexMirror: number;
    readonly maintenanceNative: number;
    readonly codexDerived: number;
    readonly reviewRequired: number;
    readonly unclassified: number;
  };
  readonly classifications: readonly CanonicalMigrationClassification[];
}

export interface CanonicalMigrationPreviewResponse {
  readonly preview: CanonicalMigrationPreview;
}

/** Stable, read-only model consumed by the standalone Maintenance dashboard. */
export interface CanonicalDashboardSessionSummary {
  readonly session: CanonicalSessionRecord;
  readonly membership: WorkspaceMembership | null;
}

export interface CanonicalDashboardWorkspace {
  readonly workspace: LogicalWorkspace;
  readonly sessions: readonly CanonicalDashboardSessionSummary[];
}

export interface CanonicalWorkspaceDirectory {
  readonly schemaVersion: 1;
  readonly workspaces: readonly CanonicalDashboardWorkspace[];
  readonly unclassified: readonly CanonicalDashboardSessionSummary[];
}

export interface CanonicalWorkspaceDirectoryResponse {
  readonly directory: CanonicalWorkspaceDirectory;
}

export interface CanonicalLineageRelation {
  readonly derivation: SessionDerivation;
  readonly session: CanonicalSessionRecord;
}

export interface CanonicalDashboardSessionDetail {
  readonly schemaVersion: 1;
  readonly session: CanonicalSessionRecord;
  readonly membership: WorkspaceMembership | null;
  readonly workspace: LogicalWorkspace | null;
  readonly events: readonly CanonicalEventV1[];
  readonly parent: CanonicalLineageRelation | null;
  readonly children: readonly CanonicalLineageRelation[];
}

export interface CanonicalDashboardSessionResponse {
  readonly session: CanonicalDashboardSessionDetail;
}

export interface CanonicalSessionMaintenancePatch {
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly workspaceId?: string | null;
  readonly displayOrder?: number;
  readonly pinned?: boolean;
  readonly archived?: boolean;
}

export interface CanonicalSessionMaintenanceResult {
  readonly session: CanonicalDashboardSessionDetail;
}

export interface CanonicalSessionDeleteResult {
  readonly logicalSessionId: string;
  readonly state: "deleted" | "pending-delete";
  readonly checkpointId: string | null;
  readonly pendingOperations: number;
}

export interface CanonicalSessionRestoreResult {
  readonly logicalSessionId: string;
  readonly state: "restored";
  readonly workspaceId: string | null;
}

export interface RecentlyDeletedSession {
  readonly session: CanonicalSessionRecord;
  readonly tombstone: import("./canonical.js").SessionTombstone | null;
  readonly pendingOperations: number;
}

export interface RecentlyDeletedResponse {
  readonly sessions: readonly RecentlyDeletedSession[];
}

export interface RunCenterItem {
  readonly run: ProjectionRun;
  readonly projectedSessions: number;
  readonly hiddenSessions: number;
  readonly pendingOperations: number;
  readonly modes: Readonly<Partial<Record<ProjectionSessionMode, number>>>;
  readonly latestStages: Readonly<Partial<Record<StatusStage, {
    readonly state: StatusEventState;
    readonly at: string;
    readonly errorCode: string | null;
    readonly diagnosticDetailRef: string | null;
  }>>>;
}

export interface RunCenterResponse {
  readonly runs: readonly RunCenterItem[];
}

export interface AdapterDashboardRecord {
  readonly manifest: AdapterManifestV1;
  readonly enabled: boolean;
  readonly sourceKind: "npm" | "local" | "generation";
  readonly sourceLabel: string;
}

export interface AdapterDashboardResponse {
  readonly adapters: readonly AdapterDashboardRecord[];
}

export interface AdapterExperimentalSelectionResponse {
  readonly selection: {
    readonly adapterId: string;
    readonly manifest: AdapterManifestV1;
    readonly probe: AdapterProbeResult;
    readonly reason: "pinned" | "verified" | "probe-compatible" | "experimental";
    readonly verificationRunId: string;
  };
}
