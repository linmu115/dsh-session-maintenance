/** Directory below a run's temporary persistence root that holds project-only cwd projections. */
export const RUNTIME_MANAGED_PROJECT_DIRECTORY = ".maintenance-projects";

/**
 * Encode a canonical project identity as one portable path segment.
 * The segment is runtime metadata only; it never replaces the canonical project id.
 */
export function runtimeManagedProjectSegment(projectId: string | null): string {
  return encodeURIComponent(projectId === null || projectId.length === 0 ? "unassigned" : projectId);
}
