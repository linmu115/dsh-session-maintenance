import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { CodexReadAdapter } from "@linmu/dsh-adapter-codex-read";
import { DshReadAdapter } from "@linmu/dsh-adapter-dsh";
import { SessionMaintenanceError, type RegisteredInstance, type SessionReadAdapter } from "@linmu/dsh-session-contracts";
import { SqliteSessionRepository, ZstdContentObjectStore, openMaintenanceDatabase } from "@linmu/dsh-session-store";

import { addInstance, initializeStateRoot, loadConfig, registeredInstances } from "./config.js";
import { SessionMaintenanceEngine } from "./engine.js";

export interface CompositionOptions {
  readonly stateRoot: string;
  readonly clock?: () => string;
  readonly fixturePolicy?: (root: string) => void;
}

function adapters(fixturePolicy?: (root: string) => void): readonly SessionReadAdapter[] {
  return [
    new CodexReadAdapter(fixturePolicy === undefined ? {} : { fixtureGuard: fixturePolicy }),
    new DshReadAdapter(fixturePolicy === undefined ? {} : { fixtureGuard: fixturePolicy }),
  ];
}

export async function probeAndAddInstance(
  options: CompositionOptions,
  instance: RegisteredInstance,
): Promise<RegisteredInstance> {
  const available = adapters(options.fixturePolicy);
  return addInstance(options.stateRoot, instance, async (resolved) => {
    const adapter = available.find((item) => item.platform === resolved.platform);
    if (adapter === undefined) throw new TypeError(`No adapter for ${resolved.platform}`);
    const probe = await adapter.probe(resolved);
    if (probe.status !== "compatible") {
      throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", `Instance contract is not compatible: ${resolved.id}`);
    }
  });
}

export async function createReadOnlyComposition(options: CompositionOptions): Promise<SessionMaintenanceEngine> {
  await initializeStateRoot(options.stateRoot);
  await mkdir(join(options.stateRoot, "objects"), { recursive: true });
  const config = await loadConfig(options.stateRoot);
  const objectStore = new ZstdContentObjectStore(options.stateRoot);
  const repository = new SqliteSessionRepository(
    openMaintenanceDatabase(join(options.stateRoot, "metadata.sqlite")),
    objectStore,
  );
  return new SessionMaintenanceEngine({
    instances: registeredInstances(config),
    adapters: adapters(options.fixturePolicy),
    repository,
    objectStore,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}
