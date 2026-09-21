import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { instanceLeaseSchema, maintenanceInstanceIdFor, type InstanceLease } from "./instance-lease.js";

/**
 * Reading and writing the instance lease file.
 *
 * Both halves of the handshake go through these functions: the instance writes
 * its lease before any Engine exists, and the Engine later reads the very same
 * path. Keeping one implementation here is what stops the two sides from
 * drifting into different files that never meet.
 */

export const INSTANCE_LEASE_DIRECTORY = "handshakes";

/** The lease path for one instance; derived from the identity alone, never configured. */
export function instanceLeasePath(stateRoot: string, instanceId: string, profileId: string): string {
  return join(stateRoot, INSTANCE_LEASE_DIRECTORY, `${maintenanceInstanceIdFor(instanceId, profileId)}.json`);
}

/** Written by the instance. A partial file must never be readable, so it is atomic. */
export async function writeInstanceLease(stateRoot: string, lease: InstanceLease): Promise<string> {
  const path = instanceLeasePath(stateRoot, lease.instanceId, lease.profileId);
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(join(stateRoot, INSTANCE_LEASE_DIRECTORY), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(instanceLeaseSchema.parse(lease))}\n`, "utf8");
  await rename(temporary, path);
  return path;
}

/** Removed by the instance on a clean stop; a missing file is a normal outcome. */
export async function removeInstanceLease(stateRoot: string, instanceId: string, profileId: string): Promise<void> {
  await unlink(instanceLeasePath(stateRoot, instanceId, profileId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

/** Read one lease as stored, without judging it. */
export async function readInstanceLease(stateRoot: string, instanceId: string, profileId: string): Promise<InstanceLease | undefined> {
  const parsed = instanceLeaseSchema.safeParse(await readJson(instanceLeasePath(stateRoot, instanceId, profileId)));
  return parsed.success ? parsed.data : undefined;
}

/** Every readable lease currently on disk, for "what can be taken over?". */
export async function listInstanceLeases(stateRoot: string): Promise<readonly InstanceLease[]> {
  const directory = join(stateRoot, INSTANCE_LEASE_DIRECTORY);
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const leases: InstanceLease[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const parsed = instanceLeaseSchema.safeParse(await readJson(join(directory, entry.name)));
    if (parsed.success) leases.push(parsed.data);
  }
  return leases;
}

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return undefined; }
}
