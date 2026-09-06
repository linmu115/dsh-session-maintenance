import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { CodexReadAdapter } from "@linmu/dsh-adapter-codex-read";
import { CodexContinuationAdapter } from "@linmu/dsh-adapter-codex-continuation";
import { DshReadAdapter } from "@linmu/dsh-adapter-dsh";
import { AdapterHost, AdapterRegistry, NodeAdapterWorkerFactory } from "@linmu/dsh-session-adapter-host";
import { adapter as alpha2Adapter } from "@linmu/dsh-session-adapter-alpha2";
import { adapter as rc1Adapter } from "@linmu/dsh-session-adapter-rc1";
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
import { ProjectionLifecycle } from "@linmu/dsh-session-projection-lifecycle";
import { MaintenanceWriteCoordinator, coordinateAsyncMethods, SqliteCanonicalRepository, SqliteCanonicalProjectionSource, SqliteAdapterEvidenceStore, SqliteAdapterRegistryRepository, SqliteCanonicalSessionEngineStore, SqliteProjectionRunRepository, SqliteSessionAliasRepository, SqliteSessionRepository, SqliteStatusEventRepository, ZstdContentObjectStore, openMaintenanceDatabase } from "@linmu/dsh-session-store";
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
import { CodexImportService } from "./codex-import-service.js";
import { createRetentionComposition } from "./retention-composition.js";
import { SqliteCodexProjectPort } from "./sqlite-codex-project-port.js";
import { InstanceIntegrationService } from "./integrations/service.js";
import { WorkspaceSyncPolicyService } from "./integrations/sync-policy.js";
import { discoverLauncherIntegrations } from "./integrations/launcher-discovery.js";
import { registerCodexSource, withDefaultCodexSource } from "./integrations/codex-sources.js";
import type { IntegrationInstallOptions } from "./integrations/launcher-install.js";
import { SessionMaintenanceQueries } from "./session-maintenance-queries.js";

const resolveModule = createRequire(import.meta.url).resolve;

function adapterWorkerEntryPoint(packageName: string, bundledFilename: string): string {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "adapters", bundledFilename);
  if (existsSync(bundled)) return bundled;
  return join(dirname(resolveModule(`${packageName}/package.json`)), "dist", "rpc-worker.js");
}

export interface CompositionOptions {
  readonly stateRoot: string;
  readonly ownerMode?: "engine" | "offline";
  readonly clock?: () => string;
  readonly fixturePolicy?: (root: string) => void;
  readonly continuationAdapter?: CodexContinuationPort;
  readonly integrationEnvironment?: { readonly launcherDataRoot: string; readonly installation: IntegrationInstallOptions; readonly codexHome?: string };
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
  const writes = MaintenanceWriteCoordinator.acquire(options.stateRoot, options.ownerMode ?? "engine");
  let closeRepository: (() => void) | undefined;
  try {
  await initializeStateRoot(options.stateRoot);
  await mkdir(join(options.stateRoot, "objects"), { recursive: true });
  const config = await loadConfig(options.stateRoot);
  const objectStore = new ZstdContentObjectStore(options.stateRoot);
  const metadataPath = activeDatabasePath(options.stateRoot, config);
  const repository = new SqliteSessionRepository(
    openMaintenanceDatabase(metadataPath),
    objectStore,
  );
  closeRepository = () => repository.close();
  coordinateAsyncMethods(repository, ["createLogicalSession", "upsertNativeMirror", "removeNativeMirror", "setLogicalSessionSyncMode", "setCanonicalVersion", "putVersion", "advanceVerifiedRefs", "recordObservation", "bindPlatformSession", "recordWorkspaceMembership", "upsertMatchCandidate", "recordObservedVersion", "savePlan", "createTransaction", "nextTransactionSequence", "recordTransactionStep", "markTransactionManualReview", "saveBackupManifest", "saveCheckpoint", "saveConfirmation", "consumeConfirmation", "createContinuationJob", "transitionContinuationJob"], writes, "store-mutation");
  // Read services retain this array; successful onboarding becomes visible without a restart.
  const instances: RegisteredInstance[] = [...registeredInstances(config)];
  const readAdapters = adapters(options.fixturePolicy);
  const codexReader = readAdapters.find(adapter => adapter.platform === "codex")!;
  const defaultCodexHome = options.integrationEnvironment === undefined
    ? process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")
    : options.integrationEnvironment.codexHome;
  const verifyCodexSource = async (instance: RegisteredInstance) => {
    if ((await codexReader.probe(instance)).status !== "compatible") throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "Codex 来源未通过读取适配器检查。");
  };
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
  coordinateAsyncMethods(statusLog, ["start", "succeed", "fail"], writes, "runtime-status");
  const evidenceStore = new SqliteAdapterEvidenceStore(
    repository.database,
    objectStore,
    options.clock === undefined ? {} : { clock: options.clock },
  );
  coordinateAsyncMethods(evidenceStore, ["putEvidence"], writes, "adapter-evidence");
  const adapterRegistry = new AdapterRegistry({
    host: new AdapterHost(new NodeAdapterWorkerFactory()),
    repository: new SqliteAdapterRegistryRepository(repository.database),
    ...(options.clock === undefined ? {} : { now: options.clock }),
  });
  const builtinAdapters = [
    {
      adapter: alpha2Adapter,
      generationId: "builtin-canonical-alpha2",
      packageName: "@linmu/dsh-session-adapter-alpha2",
      workerFile: "dsh-alpha2-rpc-worker.mjs",
    },
    {
      adapter: rc1Adapter,
      generationId: "builtin-canonical-rc1",
      packageName: "@linmu/dsh-session-adapter-rc1",
      workerFile: "dsh-rc1-rpc-worker.mjs",
    },
    {
      adapter: rc2Adapter,
      generationId: "builtin-canonical-rc2",
      packageName: "@linmu/dsh-session-adapter-rc2",
      workerFile: "dsh-rc2-rpc-worker.mjs",
    },
  ];
  for (const { adapter, generationId, packageName, workerFile } of builtinAdapters) {
    await adapterRegistry.register({
      manifest: adapter.manifest,
      source: {
        kind: "generation",
        generationId,
        packageName,
        entryPoint: adapterWorkerEntryPoint(packageName, workerFile),
      },
      enabled: true,
    }, adapter);
  }
  coordinateAsyncMethods(adapterRegistry, ["register", "select"], writes, "adapter-registration");
  const projectionRunRepository = coordinateAsyncMethods(new SqliteProjectionRunRepository(repository.database), ["createProjectionRun", "setProjectionRunState", "setProjectionRunCheckpoint", "upsertProjectionSession", "saveOperationReceipt"], writes, "projection-state");
  const canonicalProjectionSource = new SqliteCanonicalProjectionSource(repository.database, objectStore);
  const canonicalEngine = coordinateAsyncMethods(new CanonicalSessionEngine(
    new SqliteCanonicalSessionEngineStore(repository.database, objectStore, writes),
  ), ["observeCodex", "retitleCodexMirror", "appendDsh", "importDshNative", "tombstone", "restore"], writes, "canonical-commit");
  const codexImports = new CodexImportService({
    instances, adapters: readAdapters, canonicalEngine, writes,
    projectPort: new SqliteCodexProjectPort(new SqliteCanonicalRepository(repository.database)),
    evidencePort: evidenceStore,
    ...(options.fixturePolicy === undefined ? {} : { fixtureGuard: options.fixturePolicy }),
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
  const retention = await createRetentionComposition({
    database: repository.database, databasePath: metadataPath, stateRoot: options.stateRoot, writes,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return new SessionMaintenanceEngine({
    integrations: new InstanceIntegrationService({
      stateRoot: options.stateRoot, writes,
      discover: async () => {
        const sources = await withDefaultCodexSource(instances, defaultCodexHome);
        const discovered = await discoverLauncherIntegrations(options.integrationEnvironment?.launcherDataRoot ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "in.dsh-plug.dsh-launcher"), sources, instance => codexReader.probe(instance));
        return { ...discovered, targets: discovered.targets.map(target => target.target.kind === "codex"
          ? { ...target, codexRegistered: instances.some(instance => instance.platform === "codex" && instance.id === target.instanceId) }
          : target) };
      },
      installation: options.integrationEnvironment?.installation ?? { stateRoot: options.stateRoot, engineEntry: process.argv[1] ?? "" },
      verifyAdapter: async (target) => {
        if (target.target.kind === "codex") {
          if (target.codexSource === undefined) throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "Codex 来源未通过读取适配器检查。");
          await verifyCodexSource(target.codexSource);
          return;
        }
        await adapterRegistry.select({ environment: { dshVersion: target.target.version, packageVersions: target.packageVersions, runtimeCapabilities: ["sessionPersistence", "session/event", "session/flush"] }, ...(target.target.adapterId === null ? {} : { pinnedAdapterId: target.target.adapterId as never }) });
      },
      registerSource: async target => {
        if (target.target.kind !== "codex") return;
        writes.assertInScope();
        if (target.codexSource === undefined) throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "Codex 来源未通过读取适配器检查。");
        await registerCodexSource({ stateRoot: options.stateRoot, source: target.codexSource, probe: verifyCodexSource, remember: source => {
          const index = instances.findIndex(instance => instance.id === source.id);
          if (index < 0) instances.push(source);
          else instances[index] = source;
          instanceMap.set(source.id, source);
        } });
      },
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    }),
    workspaceSync: new WorkspaceSyncPolicyService({ stateRoot: options.stateRoot, writes, directory: () => new SessionMaintenanceQueries(repository.database).readCanonicalWorkspaceDirectory() }),
    instances,
    adapters: readAdapters,
    repository,
    objectStore,
    continuations,
    canonicalEngine,
    writes,
    codexImports,
    retention,
    resolveProjectionAdapter: (adapterId) => adapterRegistry.resolveRuntimeAdapter(adapterId),
    projectionLifecycleFactory: ({ adapterId, bridge }) => {
      const adapter = adapterRegistry.resolveRuntimeAdapter(adapterId);
      if (adapter === undefined) throw new TypeError(`Unsupported built-in projection adapter: ${adapterId}`);
      return coordinateAsyncMethods(new ProjectionLifecycle({
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
      }), ["prepareRun", "attachRun", "openRun", "discardPreparedRun", "append", "registerNativeSession", "hideSession", "closeRun", "recover"], writes, "projection-lifecycle");
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
  } catch (error) { closeRepository?.(); writes.close(); throw error; }
}

export function createReadOnlyComposition(options: CompositionOptions): Promise<SessionMaintenanceEngine> {
  return createComposition(options, []);
}

export function createDshWritableComposition(options: DshWritableCompositionOptions): Promise<SessionMaintenanceEngine> {
  if (options.dshGatewayTargets.length === 0) throw new TypeError("Writable composition requires at least one DSH Core gateway target");
  return createComposition(options, options.dshGatewayTargets);
}
