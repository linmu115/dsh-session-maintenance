import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  Checkpoint,
  ProjectionInspection,
  ProjectionRun,
} from "@linmu/dsh-session-contracts";

export interface ProjectionCloseReceipt {
  readonly runId: ProjectionRun["id"];
  readonly checkpointId: string;
  readonly finalCatalogDigest: string;
  readonly removedProjection: true;
  readonly state: "closed" | "recovered";
}

export function projectionCloseCheckpoint(
  run: ProjectionRun,
  inspection: ProjectionInspection,
  at: string,
): Checkpoint {
  const identity = JSON.stringify({ runId: run.id, digest: inspection.catalogDigest, at });
  return {
    id: `checkpoint_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`,
    name: `Projection close ${run.id}`,
    description: `Verified projection close for ${run.adapterId}`,
    refs: {
      run: run.id,
      catalog: inspection.catalogDigest,
    },
    backupTransactionIds: [],
    createdBy: "projection-lifecycle",
    createdAt: at,
  };
}

export async function removeProjectionRun(projectionRoot: string): Promise<void> {
  await rm(dirname(projectionRoot), { recursive: true, force: false });
}
