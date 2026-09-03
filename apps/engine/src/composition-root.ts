import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { CodexReadAdapter } from "@linmu/dsh-adapter-codex-read";
import { CodexContinuationAdapter } from "@linmu/dsh-adapter-codex-continuation";
import { DshReadAdapter } from "@linmu/dsh-adapter-dsh";
import { AdapterHost, AdapterRegistry, NodeAdapterWorkerFactory } from "@linmu/dsh-session-adapter-host";
import { manifest as alpha2AdapterManifest } from "@linmu/dsh-session-adapter-alpha2";
import { manifest as rc2AdapterManifest } from "@linmu/dsh-session-adapter-rc2";
import { adapter as alpha2Adapter } from "@linmu/dsh-session-adapter-alpha2";
import { adapter as rc2Adapter } from "@linmu/dsh-session-adapter-rc2";
import { DshWriteAdapter } from "@linmu/dsh-adapter-dsh-write";
import { RemoteDshHostGateway } from "@linmu/dsh-host-gateway";
import {
  SessionMaintenanceError,
  normalizedSessionSchema,
  type CodexContinuationPort,
  type NormalizedSession,
  type PlatformWriteAdapter,
  type RegisteredInstance,
  type SessionReadAdapter,
  type StateFingerprint,
  type SyncPlan,
} from "@linmu/dsh-session-contracts";
import { ContinuationService } from "@linmu/dsh-session-continuation-engine";
import { CanonicalSessionEngine } from "@linmu/dsh-canonical-session-engine";
import { StatusLog, SqliteStatusEventAdapter } from "@linmu/dsh-session-status-log";
import { ProjectionLifecycle, SqliteCanonicalProjectionSource } from "@linmu/dsh-session-projection-lifecycle";
import { SqliteAdapterEvidenceStore, SqliteAdapterRegistryRepository, SqliteCanonicalSessionEngineStore, SqliteProjectionRunRepository, SqliteSessionAliasRepository, SqliteSessionRepository, SqliteStatusEventRepository, ZstdContentObjectStore, openMaintenanceDatabase } from "@linmu/dsh-session-store";
import { ConfirmationService, TransactionExecutor } from "@linmu/dsh-session-transaction-engine";

import {
  addInstance,
  activateDatabaseFile,
  activeDatabasePath,
  initializeStateRoot,
  loadConfig,
  registeredCodexTargets,
  registeredInstances,
  updateSettings,
} from "./config.js";
import { SessionMaintenanceEngine } from "./engine.js";
import {
  EngineDescriptorDshGatewayConnections,
  type DshGatewayTarget,
} from "./dsh-gateway-connection.js";
import { WriteService } from "./write-service.js";
import { CodexCatalogTitleSyncService } from "./codex-catalog-title-sync.js";

const resolveModule = createRequire(import.meta.url).resolve;
const alpha2WorkerEntryPoint = join(
  dirname(resolveModule("@linmu/dsh-session-adapter-alpha2/package.json")),
  "dist",
  "rpc-worker.js",
);
const rc2WorkerEntryPoint = join(
  dirname(resolveModule("@linmu/dsh-session-adapter-rc2/package.json")),
  "dist",
  "rpc-worker.js",
);

export interface CompositionOptions {
  readonly stateRoot: string;
  readonly clock?: () => string;
  readonly fixturePolicy?: (root: string) => void;
  readonly continuationAdapter?: CodexContinuationPort;
}

export interface DshWritableCompositionOptions extends CompositionOptions {
  readonly dshGatewayTargets: readonly DshGatewayTarget[];
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

async function loadVersionBody(
  repository: SqliteSessionRepository,
  objectStore: ZstdContentObjectStore,
  plan: SyncPlan,
): Promise<NormalizedSession> {
  const version = await repository.getVersion(plan.source.versionId);
  if (version?.logicalSessionId !== plan.logicalSessionId) {
    throw new SessionMaintenanceError("OBJECT_CORRUPT", `Plan source version is missing: ${plan.source.versionId}`);
  }
  return normalizedSessionSchema.parse(
    JSON.parse(Buffer.from(await objectStore.get(version.bodyObject)).toString("utf8")),
  ) as unknown as NormalizedSession;
}

async function currentFingerprints(input: {
  readonly plan: SyncPlan;
  readonly instances: ReadonlyMap<string, RegisteredInstance>;
  readonly adapters: readonly SessionReadAdapter[];
}): Promise<readonly StateFingerprint[]> {
  const byPlatform = new Map(input.adapters.map((adapter) => [adapter.platform, adapter]));
  return Promise.all(input.plan.preconditions.map(async (fingerprint) => {
    const instance = input.instances.get(fingerprint.instanceId);
    const adapter = byPlatform.get(fingerprint.platform);
    if (instance === undefined || instance.platform !== fingerprint.platform || adapter === undefined) {
      throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", `Plan instance is no longer registered: ${fingerprint.instanceId}`);
    }
    const observation = await adapter.observe(instance, fingerprint);
    if (observation.kind === "unstable") {
      throw new SessionMaintenanceError("UNSTABLE_READ", observation.reason);
    }
    return observation.fingerprint;
  }));
}

async function createComposition(
  options: CompositionOptions,
  dshGatewayTargets: readonly DshGatewayTarget[],
): Promise<SessionMaintenanceEngine> {
  await initializeStateRoot(options.stateRoot);
  await mkdir(join(options.stateRoot, "objects"), { recursive: true });
  const config = await loadConfig(options.stateRoot);
  const objectStore = new ZstdContentObjectStore(options.stateRoot);
  const metadataPath = activeDatabasePath(options.stateRoot, config);
  const repository = new SqliteSessionRepository(
    openMaintenanceDatabase(metadataPath),
    objectStore,
  );
  const instances = registeredInstances(config);
  const readAdapters = adapters(options.fixturePolicy);
  const continuations = new ContinuationService({
    repository,
    objectStore,
    adapter: options.continuationAdapter ?? new CodexContinuationAdapter(),
    targets: registeredCodexTargets(config),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const statusLog = new StatusLog(
    new SqliteStatusEventAdapter(new SqliteStatusEventRepository(repository.database)),
    options.clock === undefined ? {} : { clock: options.clock },
  );
  const evidenceStore = new SqliteAdapterEvidenceStore(
    repository.database,
    objectStore,
    options.clock === undefined ? {} : { clock: options.clock },
  );
  const adapterRegistry = new AdapterRegistry({
    host: new AdapterHost(new NodeAdapterWorkerFactory()),
    repository: new SqliteAdapterRegistryRepository(repository.database),
    ...(options.clock === undefined ? {} : { now: options.clock }),
  });
  await adapterRegistry.register({
    manifest: alpha2AdapterManifest,
    source: {
      kind: "generation",
      generationId: "builtin-canonical-alpha2",
      packageName: "@linmu/dsh-session-adapter-alpha2",
      entryPoint: alpha2WorkerEntryPoint,
    },
    enabled: true,
  });
  await adapterRegistry.register({
    manifest: rc2AdapterManifest,
    source: {
      kind: "generation",
      generationId: "builtin-canonical-rc2",
      packageName: "@linmu/dsh-session-adapter-rc2",
      entryPoint: rc2WorkerEntryPoint,
    },
    enabled: true,
  });
  const projectionRunRepository = new SqliteProjectionRunRepository(repository.database);
  const canonicalProjectionSource = new SqliteCanonicalProjectionSource(repository.database, objectStore);
  const canonicalEngine = new CanonicalSessionEngine(
    new SqliteCanonicalSessionEngineStore(repository.database, objectStore),
  );
  const codexCatalogTitleSync = new CodexCatalogTitleSyncService({
    instances,
    adapters: readAdapters,
    canonicalEngine,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const sessionAliases = new SqliteSessionAliasRepository(repository.database);
  let writeService: WriteService | undefined;
  const instanceMap = new Map(instances.map((instance) => [instance.id, instance]));
  const writeAdapters = new Map<"codex" | "dsh", PlatformWriteAdapter>();
  if (dshGatewayTargets.length > 0) {
    for (const target of dshGatewayTargets) {
      const instance = instanceMap.get(target.instanceId);
      if (instance?.platform !== "dsh" || instance.platformVersion !== "0.1.1-rc.2") {
        throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", `Writable DSH target is not registered as 0.1.1-rc.2: ${target.instanceId}`);
      }
    }
    const gateway = new RemoteDshHostGateway({
      connections: new EngineDescriptorDshGatewayConnections(options.stateRoot, dshGatewayTargets),
    });
    const writer = new DshWriteAdapter({
      stateRoot: options.stateRoot,
      gateway,
      loadSource: (plan) => loadVersionBody(repository, objectStore, plan),
      ...(options.clock === undefined ? {} : { now: () => new Date(options.clock!()) }),
    });
    writeAdapters.set("dsh", writer);
  }
  if (writeAdapters.size > 0) {
    const executor = new TransactionExecutor({
      stateRoot: options.stateRoot,
      repository,
      adapters: writeAdapters,
      instances: instanceMap,
      readFingerprints: (plan) => currentFingerprints({ plan, instances: instanceMap, adapters: readAdapters }),
      confirmationService: new ConfirmationService(repository),
      ...(options.clock === undefined ? {} : { now: () => new Date(options.clock!()) }),
    });
    writeService = new WriteService({
      repository,
      objectStore,
      executor,
      instances: instanceMap,
      readers: new Map(readAdapters.map((adapter) => [adapter.platform, adapter])),
    });
  }
  return new SessionMaintenanceEngine({
    instances,
    adapters: readAdapters,
    repository,
    objectStore,
    continuations,
    canonicalEngine,
    beforeProjectionPrepare: async () => { await codexCatalogTitleSync.sync(); },
    projectionLifecycleFactory: ({ adapterId, bridge }) => {
      const adapter = adapterId === alpha2Adapter.manifest.id
        ? alpha2Adapter
        : adapterId === rc2Adapter.manifest.id
          ? rc2Adapter
          : undefined;
      if (adapter === undefined) throw new TypeError(`Unsupported built-in projection adapter: ${adapterId}`);
      return new ProjectionLifecycle({
        runRepository: projectionRunRepository,
        statusLog,
        source: canonicalProjectionSource,
        adapter,
        bridge,
        canonicalEngine,
        evidencePort: evidenceStore,
        checkpointRepository: repository,
        runtimeRoot: join(options.stateRoot, "projection-runtime"),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
    },
    migrationSourcePath: metadataPath,
    migrationCandidatePath: join(options.stateRoot, "metadata.canonical-candidate.sqlite"),
    migrationArchivePath: join(options.stateRoot, "metadata.pre-canonical-v6.sqlite"),
    migrationPort: {
      activateDatabaseFile: async (databaseFile) => { await activateDatabaseFile(options.stateRoot, databaseFile); },
    },
    statusLog,
    adapterRegistry,
    projectionRunRepository,
    canonicalProjectionSource,
    sessionAliases,
    projectionRuntimeRoot: join(options.stateRoot, "projection-runtime"),
    settingsPort: {
      get: async () => (await loadConfig(options.stateRoot)).settings,
      patch: (input) => updateSettings(options.stateRoot, input),
    },
    ...(writeService === undefined ? {} : { writeService }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}

export function createReadOnlyComposition(options: CompositionOptions): Promise<SessionMaintenanceEngine> {
  return createComposition(options, []);
}

export function createDshWritableComposition(options: DshWritableCompositionOptions): Promise<SessionMaintenanceEngine> {
  if (options.dshGatewayTargets.length === 0) throw new TypeError("Writable composition requires at least one DSH Core gateway target");
  return createComposition(options, options.dshGatewayTargets);
}
