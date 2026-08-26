import type { EngineStatus, Page, SessionSummary, VersionGraphPage } from "./model.js";
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

export interface VersionGraphResponse {
  readonly graph: VersionGraphPage;
}

export interface PlanResponse {
  readonly plan: SyncPlan;
}

export interface JobAcceptedResponse {
  readonly job: JobRef;
}
