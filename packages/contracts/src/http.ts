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
