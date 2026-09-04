import type {
  DashboardOverview,
  CanonicalProjectDirectory,
} from "@linmu/dsh-session-contracts";

export interface DashboardSummaryApi {
  overview(signal?: AbortSignal): Promise<DashboardOverview>;
  listCanonicalProjects(signal?: AbortSignal): Promise<CanonicalProjectDirectory>;
}

export interface DashboardSummary {
  readonly overview: DashboardOverview;
  readonly canonicalDirectory: CanonicalProjectDirectory;
}

export async function loadDashboardSummary(
  api: DashboardSummaryApi,
  signal?: AbortSignal,
): Promise<DashboardSummary> {
  const [overview, canonicalDirectory] = await Promise.all([
    api.overview(signal),
    api.listCanonicalProjects(signal),
  ]);
  return { overview, canonicalDirectory };
}
