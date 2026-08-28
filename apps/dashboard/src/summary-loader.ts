import type {
  DashboardOverview,
  Page,
  SessionQuery,
  SessionSummary,
  WorkspaceSummary,
} from "@linmu/dsh-session-contracts";

export interface DashboardSummaryApi {
  overview(signal?: AbortSignal): Promise<DashboardOverview>;
  listSessions(query?: SessionQuery, signal?: AbortSignal): Promise<Page<SessionSummary>>;
  listWorkspaces(signal?: AbortSignal): Promise<readonly WorkspaceSummary[]>;
}

export interface DashboardSummary {
  readonly overview: DashboardOverview;
  readonly workspaces: readonly WorkspaceSummary[];
}

export async function loadDashboardSummary(
  api: DashboardSummaryApi,
  signal?: AbortSignal,
): Promise<DashboardSummary> {
  const [overview, workspaces] = await Promise.all([
    api.overview(signal),
    api.listWorkspaces(signal),
  ]);
  return { overview, workspaces };
}

export function loadWorkspaceSessionPage(
  api: DashboardSummaryApi,
  workspaceId: string | null,
  cursor?: string,
  signal?: AbortSignal,
): Promise<Page<SessionSummary>> {
  return api.listSessions({ ...(cursor === undefined ? {} : { cursor }), workspaceId, limit: 25 }, signal);
}
