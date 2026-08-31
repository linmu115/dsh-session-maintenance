import type {
  DashboardOverview,
  CanonicalWorkspaceDirectory,
} from "@linmu/dsh-session-contracts";

export interface DashboardSummaryApi {
  overview(signal?: AbortSignal): Promise<DashboardOverview>;
  listCanonicalWorkspaces(signal?: AbortSignal): Promise<CanonicalWorkspaceDirectory>;
}

export interface DashboardSummary {
  readonly overview: DashboardOverview;
  readonly canonicalDirectory: CanonicalWorkspaceDirectory;
}

export async function loadDashboardSummary(
  api: DashboardSummaryApi,
  signal?: AbortSignal,
): Promise<DashboardSummary> {
  const [overview, canonicalDirectory] = await Promise.all([
    api.overview(signal),
    api.listCanonicalWorkspaces(signal),
  ]);
  return { overview, canonicalDirectory };
}
