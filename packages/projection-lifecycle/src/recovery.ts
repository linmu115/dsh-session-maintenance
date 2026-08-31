import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RunId } from "@linmu/dsh-session-contracts";

export interface ProjectionRecoveryDescriptor {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly maintenanceEndpoint: string;
}

function pathFor(projectionRoot: string): string {
  return join(dirname(projectionRoot), "recovery.json");
}

export async function writeProjectionRecoveryDescriptor(
  projectionRoot: string,
  descriptor: ProjectionRecoveryDescriptor,
): Promise<void> {
  await mkdir(dirname(pathFor(projectionRoot)), { recursive: true });
  await writeFile(pathFor(projectionRoot), `${JSON.stringify(descriptor)}\n`, { encoding: "utf8", flag: "wx" });
}

export async function readProjectionRecoveryDescriptor(
  projectionRoot: string,
): Promise<ProjectionRecoveryDescriptor> {
  const descriptor = JSON.parse(await readFile(pathFor(projectionRoot), "utf8")) as ProjectionRecoveryDescriptor;
  if (descriptor.schemaVersion !== 1 || typeof descriptor.runId !== "string" || typeof descriptor.maintenanceEndpoint !== "string") {
    throw new TypeError("Projection recovery descriptor is invalid");
  }
  return descriptor;
}
