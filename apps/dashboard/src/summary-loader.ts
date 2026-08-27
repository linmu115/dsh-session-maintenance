import type {
  DashboardOverview,
  Page,
  SessionQuery,
  SessionSummary,
} from "@linmu/dsh-session-contracts";

export interface DashboardSummaryApi {
  overview(signal?: AbortSignal): Promise<DashboardOverview>;
  listSessions(query?: SessionQuery, signal?: AbortSignal): Promise<Page<SessionSummary>>;
}

export interface DashboardSummary {
  readonly overview: DashboardOverview;
  readonly sessions: Page<SessionSummary>;
}

export async function loadDashboardSummary(
  api: DashboardSummaryApi,
  signal?: AbortSignal,
): Promise<DashboardSummary> {
  const [overview, sessions] = await Promise.all([
    api.overview(signal),
    api.listSessions({ limit: 25 }, signal),
  ]);
  return { overview, sessions };
}

export function loadSessionPage(
  api: DashboardSummaryApi,
  cursor: string,
  signal?: AbortSignal,
): Promise<Page<SessionSummary>> {
  return api.listSessions({ cursor, limit: 25 }, signal);
}
