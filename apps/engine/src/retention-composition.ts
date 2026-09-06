import { mkdir } from "node:fs/promises";
import { relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { MaintenanceWriteScope } from "@linmu/dsh-session-contracts";
import { RetentionRepository, checkedRetentionDestination, checkedRetentionPath } from "@linmu/dsh-session-store";

import { RetentionService } from "./retention-service.js";

/** Register Engine-owned locations at startup; previews themselves remain read-only. */
export async function createRetentionComposition(input: {
  readonly database: DatabaseSync;
  readonly databasePath: string;
  readonly stateRoot: string;
  readonly writes: MaintenanceWriteScope;
  readonly clock?: () => string;
}): Promise<RetentionService> {
  const repository = new RetentionRepository(input.database, input.databasePath);
  await input.writes.run("retention-initialize", async () => {
    const state = await repository.registerRoot("engine-state", input.stateRoot, "state");
    await repository.bindActiveSource("engine-state", relative(input.stateRoot, input.databasePath).replaceAll("\\", "/"), "engine-state");
    // Check each existing parent before creating the next owned directory.
    for (const path of ["projection-runtime", "projection-runtime/runs", "projection-runtime/caches", "transactions"]) {
      await mkdir(await checkedRetentionDestination(state, path), { recursive: true });
      await checkedRetentionPath(state, path);
    }
    for (const [id, path, purpose] of [
      ["engine-runs", "projection-runtime/runs", "runs"],
      ["engine-caches", "projection-runtime/caches", "caches"],
      ["engine-backups", "transactions", "backups"],
    ] as const) {
      await repository.registerRoot(id, await checkedRetentionPath(state, path), purpose);
    }
  });
  // This enables authenticated explicit actions. No timer or automatic job is
  // installed, and content-object deletion is unavailable in this release.
  return new RetentionService({ repository, writes: input.writes, executionEnabled: true,
    ...(input.clock === undefined ? {} : { clock: input.clock }) });
}
