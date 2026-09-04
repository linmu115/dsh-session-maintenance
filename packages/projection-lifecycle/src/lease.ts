import type {
  ProjectionRun,
  ProjectionRunRepository,
  ProjectionRunState,
  RunId,
} from "@linmu/dsh-session-contracts";

export class ProjectionLeaseError extends Error {
  readonly code = "LEASE_HELD";

  constructor(message = "Another projection run already owns the active writer branch") {
    super(message);
    this.name = "ProjectionLeaseError";
  }
}

function isUniqueConstraint(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { readonly code?: unknown }).code;
  return code === "SQLITE_CONSTRAINT_UNIQUE"
    || code === "SQLITE_CONSTRAINT"
    || /unique|active writer branch lease/iu.test(error.message);
}

export class ProjectionLease {
  readonly repository: ProjectionRunRepository;

  constructor(repository: ProjectionRunRepository) {
    this.repository = repository;
  }

  async registerCandidate(run: ProjectionRun): Promise<void> {
    if (run.state !== "quarantined") throw new TypeError("Lease candidates must start quarantined");
    await this.repository.createProjectionRun(run);
  }

  async acquire(runId: RunId): Promise<void> {
    try {
      await this.repository.setProjectionRunState(runId, "preparing");
    } catch (error) {
      if (isUniqueConstraint(error)) throw new ProjectionLeaseError();
      throw error;
    }
  }

  setState(runId: RunId, state: ProjectionRunState): Promise<void> {
    return this.repository.setProjectionRunState(runId, state);
  }
}
