import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { CodexReadAdapter } from "@linmu/dsh-adapter-codex-read";
import { CodexContinuationAdapter } from "@linmu/dsh-adapter-codex-continuation";
import { DshReadAdapter } from "@linmu/dsh-adapter-dsh";
import {
  SessionMaintenanceError,
  type CodexContinuationPort,
  type RegisteredInstance,
  type SessionReadAdapter,
} from "@linmu/dsh-session-contracts";
import { ContinuationService } from "@linmu/dsh-session-continuation-engine";
import { SqliteSessionRepository, ZstdContentObjectStore, openMaintenanceDatabase } from "@linmu/dsh-session-store";

import {
  addInstance,
  initializeStateRoot,
  loadConfig,
  registeredCodexTargets,
  registeredInstances,
  updateSettings,
} from "./config.js";
import { SessionMaintenanceEngine } from "./engine.js";

export interface CompositionOptions {
  readonly stateRoot: string;
  readonly clock?: () => string;
  readonly fixturePolicy?: (root: string) => void;
  readonly continuationAdapter?: CodexContinuationPort;
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
  const continuations = new ContinuationService({
    repository,
    objectStore,
    adapter: options.continuationAdapter ?? new CodexContinuationAdapter(),
    targets: registeredCodexTargets(config),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return new SessionMaintenanceEngine({
    instances: registeredInstances(config),
    adapters: adapters(options.fixturePolicy),
    repository,
    objectStore,
    continuations,
    settingsPort: {
      get: async () => (await loadConfig(options.stateRoot)).settings,
      patch: (input) => updateSettings(options.stateRoot, input),
    },
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}
