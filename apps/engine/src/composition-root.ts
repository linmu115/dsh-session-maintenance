import { nativeReaderProvider } from "./adapters/reader/composition.js";
import { attachLynn, lynnExtensionHooks } from "./adapters/lynn/composition.js";
import { synchronizeGptIndex } from "./adapters/gpt-compat/gpt-sync.js";
import { BusinessPageRegistry } from "./business-pages.js";
import { AdapterCatalog } from './adapter-catalog.js';
import { CodexMirrorPolicy } from './codex-mirror-policy.js';
import { checkCodexEnvironment } from './codex-environment-check.js';
import { InstanceWorkspaceRuntime } from "./instance-workspace-runtime.js";
import { adapter as v3Adapter } from "@linmu/dsh-session-extension-gpt-compat";
import { SqliteExtensionRepository } from "@linmu/dsh-session-store";
import { ExtensionDataService } from "./extensions/service.js";
import { builtInExtensionAdapters } from "./extensions/adapters.js";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { DiscoveredIntegration, InstanceLeaseInspection, LogicalWorkspace, LogicalWorkspaceId, RuntimeBrokerPrepareRunRequest } from "@linmu/dsh-session-contracts";
import { writeBackRunIdentity } from '@linmu/dsh-instance-integration-dsh/instance-write-back';
import { synchronizeThroughHost, readHostPluginData } from '@linmu/dsh-instance-integration-dsh/host-workspace-sync';
import { readEndpointSnapshot } from '@linmu/dsh-instance-integration-dsh/endpoint-snapshot';
import { IntegrationError } from './integrations/bindings.js';
import { createWorkspaceSourceForHome, dshSessionBinding, projectedLogicalSessionId } from '@linmu/dsh-instance-integration-dsh/instance-workspace-source';
import { ensurePlatformSessionBinding } from './platform-session-binding.js';
import { commitEndpointSessionChange } from './endpoint-session-commands.js';
import { v3EndpointSessionId } from '@linmu/dsh-session-adapter-0-1-5';
import { mapJoinedWorkspace, mappedLogicalSessionId } from './workspace-session-mapping.js';
import { createWorkspaceFolderAdapter, rememberJoinedWorkspace } from '@linmu/dsh-instance-integration-dsh/workspace-folders';

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
import { CanonicalSessionEngine, reconcileEndpointSession } from "@linmu/dsh-canonical-session-engine";
import { StatusLog, SqliteStatusEventAdapter } from "@linmu/dsh-session-status-log";
import { ProjectionLifecycle, sourceWithEvidence, type SourceAdapterResolver } from "@linmu/dsh-session-projection-lifecycle";
import { MaintenanceWriteCoordinator, coordinateAsyncMethods, SqliteCanonicalRepository, SqliteCanonicalProjectionSource, SqliteAdapterEvidenceStore, SqliteAdapterRegistryRepository, SqliteCanonicalSessionEngineStore, SqliteProjectionRunRepository, SqliteInstanceWorkspacePolicyRepository, SqliteSessionAliasRepository, SqliteSessionRepository, SqliteStatusEventRepository, ZstdContentObjectStore, openMaintenanceDatabase } from "@linmu/dsh-session-store";
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
import { CodexProjectMappingService } from "./codex-project-mapping.js";
import { CodexProjectObserver } from "./codex-project-observer.js";
import type { CodexCanonicalImportOptions } from "./codex-canonical-import.js";
import { createRetentionComposition } from "./retention-composition.js";
import { SqliteCodexProjectPort } from "./sqlite-codex-project-port.js";
import { InstanceIntegrationService } from '@linmu/dsh-instance-integration-dsh/integration-service';
import { scopedRecoveryRuns } from './lifecycle-recovery.js';
import { WorkspaceSyncPolicyService } from "./integrations/sync-policy.js";
import { discoverLauncherIntegrations } from "./integrations/launcher-discovery.js";
import { discoverStandaloneInstances } from './integrations/standalone.js';
import { readBoundStandaloneInstances as readStandaloneInstances } from './integrations/standalone.js';
import { readLauncherInstanceDirectory } from "./integrations/launcher-instance-directory.js";
import { registerCodexSource, withDefaultCodexSource } from "./integrations/codex-sources.js";
import type { IntegrationInstallOptions } from "./integrations/launcher-install.js";
import { SessionMaintenanceQueries } from "./session-maintenance-queries.js";
import { knowledgeLifecycleAdapters } from '@linmu/dsh-session-adapter-lynn/session-lifecycle';
import { SessionLifecycle } from './session-lifecycle.js';

const resolveModule = createRequire(import.meta.url).resolve;

function adapterWorkerEntryPoint(packageName: string, bundledFilename: string): string {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "adapters", bundledFilename);
  if (existsSync(bundled)) return bundled;
  return join(dirname(resolveModule(`${packageName}/package.json`)), "dist", "rpc-worker.js");
}

/**
 * The machine's default workspace root for instance-side folders.
 *
 * D:\DSHworkplace is the root this machine's operator chose; another machine overrides it with
 * DSH_SESSION_MAINTENANCE_WORKSPACE_ROOT or with the CLI option, because a path is a machine fact
 * and must not be baked into the artifact.
 */
function workspaceRootDefault(): string {
  const configured = process.env.DSH_SESSION_MAINTENANCE_WORKSPACE_ROOT?.trim();
  return configured !== undefined && configured.length > 0 ? configured : 'D:\\\\DSHworkplace';
}
export interface CompositionOptions {
  readonly inspectCodexEnvironment?: typeof checkCodexEnvironment;
  readonly extensionAdapters?: readonly import("@linmu/dsh-session-contracts").ExtensionDataAdapter[];
  readonly sessionLifecycleAdapters?: readonly import('@linmu/dsh-session-contracts').SessionLifecycleAdapter[];
  /** Optional host management. Canonical storage and business adapters can run without it. */
  readonly hostIntegrations?: boolean;
  readonly stateRoot: string;
  /**
   * Where an instance's workspaces are created locally, one folder per Maintenance bucket.
   *
   * Maintenance stores buckets, not workspaces; the instance needs real directories to own sessions,
   * so mapping a bucket writes its sessions into `<workspaceRoot>/<bucket name>` and points their
   * `cwd` there. Overridable per machine (`DSH_SESSION_MAINTENANCE_WORKSPACE_ROOT`).
   */
  readonly workspaceRoot?: string;
  readonly ownerMode?: "engine" | "offline";
  readonly clock?: () => string;
  readonly fixturePolicy?: (root: string) => void;
  readonly continuationAdapter?: CodexContinuationPort;
  /** Overridden by tests; production uses the native Windows chooser. */
  readonly pickInstanceFolder?: import("./instance-folder.js").InstanceFolderPicker;
  readonly integrationEnvironment?: { readonly launcherDataRoot: string; readonly installation: IntegrationInstallOptions; readonly codexHome?: string };
}

export interface DshWritableCompositionOptions extends CompositionOptions {
  readonly dshGatewayTargets: readonly DshGatewayTarget[];
}

/**
 * The run request for a takeover of an already running instance.
 *
 * It is the same request the Launcher sends, with the Engine as the owner: the
 * instance's own runtime endpoint is where the plugin will be asked to attach,
 * and its adapter and version come from the binding that was already verified.
 * `projectSelection` stays "all" because project-id filtering is not available
 * in the Runtime Broker yet — that is a pre-existing limit, not a widening of
 * the instance's synchronised workspace scope, which the run freezes separately.
 */
function takeoverPrepareRequest(target: DiscoveredIntegration, inspection: InstanceLeaseInspection): RuntimeBrokerPrepareRunRequest {
  return { schemaVersion: 1, client: { kind: "cli", id: `takeover-owner-${randomUUID()}` },
    runtimeClientId: `plugin-${randomUUID()}`, instanceId: target.instanceId, profileId: target.target.profile!,
    dshVersion: target.target.version, maintenanceEndpoint: inspection.runtimeUrl!, branchId: "main" as never,
    environment: { packageVersions: { ...target.packageVersions },
      runtimeCapabilities: [...(target.runtimeCapabilities ?? ["sessionPersistence", "session/event", "session/flush"])] },
    pinnedAdapterId: (target.target.adapterId ?? null) as never, projectSelection: { kind: "all" } };
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
  const adapterCatalog = new AdapterCatalog(options.stateRoot);
  const installedAdapters = await adapterCatalog.load();
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
  const codexMirror = new CodexMirrorPolicy(options.stateRoot, preferences => (options.inspectCodexEnvironment ?? checkCodexEnvironment)(preferences, instances, codexReader));
  await codexMirror.initialize();
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
    { adapter: v3Adapter, generationId: "builtin-canonical-0-1-5-extensions-v1", packageName: "@linmu/dsh-session-extension-gpt-compat", workerFile: "dsh-0-1-5-rpc-worker.mjs" },
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
    if (installedAdapters.entries.some(item => item.kind === 'instance' && item.id === adapter.manifest.id)) continue;
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
  for (const { entry, adapter } of installedAdapters.instances) {
    if (adapterRegistry.list().some(item => item.manifest.id === entry.id)) throw new Error(`Installed adapter conflicts with a bundled adapter: ${entry.id}`);
    await adapterRegistry.register({ manifest: adapter.manifest, source: { kind: 'local', directory: entry.directory, entryPoint: entry.worker! }, enabled: true }, adapter);
  }
  const projectionRunRepository = coordinateAsyncMethods(new SqliteProjectionRunRepository(repository.database), ["createProjectionRun", "setProjectionRunState", "setProjectionRunCheckpoint", "upsertProjectionSession", "saveOperationReceipt"], writes, "projection-state");
  const canonicalProjectionSource = new SqliteCanonicalProjectionSource(repository.database, objectStore);
  let composedEngine: SessionMaintenanceEngine | undefined;
  const instanceWorkspaceRuntime = new InstanceWorkspaceRuntime(repository.database, instances, writes, runId => composedEngine?.runtimeBroker.isRunActive(runId) ?? false,
    () => options.hostIntegrations === false ? Promise.resolve(null) : readLauncherInstanceDirectory(options.integrationEnvironment?.launcherDataRoot ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "in.dsh-plug.dsh-launcher")),
    // Saving a range is what puts it into the instance: the board's save is the operator's
    // "sync this workspace to the instance" action, so the write-back belongs on that path.
    async (instanceId, profileId) => {
      const registered = (await readStandaloneInstances(options.stateRoot)).find(item => item.instanceId === instanceId && item.profileId === profileId);
      if (registered === undefined)
        throw new IntegrationError("INSTANCE_WRITE_BACK_NOT_REGISTERED", "该实例尚未接入，无法把工作区写入实例目录。", 404);
      return synchronizeThroughHost({
        withStoreAccess: work => writes.run('host-sync-snapshot', work),
        bindIdentity: (nativeSessionId, logicalSessionId, checkOnly) => ensurePlatformSessionBinding({ repository,
          ...dshSessionBinding(instanceId, nativeSessionId), logicalSessionId, checkOnly }),
        stateRoot: options.stateRoot,
        backupRoot: join(options.stateRoot, "backups", "write-back"),
        journalPath: join(options.stateRoot, "logs", "instance-write-back.jsonl"),
        // Maintenance has no workspaces of its own: it keeps buckets of sessions. The instance needs
        // real folders to own them, so each bucket is mapped to its own folder under this root, named
        // after the bucket and reused when it already exists.
        workspaceRoot: options.workspaceRoot ?? workspaceRootDefault(),
        selectionFor: () => new SqliteInstanceWorkspacePolicyRepository(repository.database).getPolicy(instanceId),
        memberships: async () => new Map((repository.database.prepare("SELECT logical_session_id, workspace_id FROM workspace_memberships")
          .all() as { logical_session_id: string; workspace_id: string | null }[]).map(row => [row.logical_session_id, row.workspace_id as LogicalWorkspaceId | null])),
        workspaceNames: async () => new Map((repository.database.prepare("SELECT id, name FROM logical_workspaces WHERE deleted_at IS NULL")
          .all() as { id: string; name: string }[]).map(row => [row.id, row.name])),
        loadProjection: run => canonicalProjectionSource.load(run),
      }, { instanceId, profileId, sessionsRoot: join(registered.homeRoot, "sessions"), instanceHome: registered.homeRoot });
    },
    () => readStandaloneInstances(options.stateRoot), options.workspaceRoot,
    createWorkspaceFolderAdapter({ stateRoot: options.stateRoot, workspaceRoot: options.workspaceRoot ?? workspaceRootDefault(),
      homeFor: async endpointId => (await readStandaloneInstances(options.stateRoot)).find(item => item.instanceId === endpointId)?.homeRoot }),
    (endpointId, command) => {
      const refresh = async (id: string, sessionId: string, existingId: string | undefined, originalOnly = false) => {
        const registered = (await readStandaloneInstances(options.stateRoot)).find(item => item.instanceId === id && item.profileId === command.profileId);
        if (!registered) throw new IntegrationError('SYNC_PROFILE_MISMATCH', '同步接入身份不存在。');
        const logicalSessionId = (existingId ?? mappedLogicalSessionId(id, sessionId)) as import('@linmu/dsh-session-contracts').LogicalSessionId;
        // Discovery is insert-only, including an unbound canonical identity or tombstone.
        if (command.change.kind === 'discover' && !originalOnly && repository.database.prepare('SELECT id FROM logical_sessions WHERE id=?').get(logicalSessionId))
          throw new IntegrationError('SYNC_DISCOVERY_EXISTS', '此会话已有真源记录，需按已有会话协议同步。', 409);
        const projection = await canonicalProjectionSource.loadSessions(writeBackRunIdentity(id, registered.profileId), [logicalSessionId]);
        const snapshot = await readEndpointSnapshot({ endpointId: id, nativeSessionId: sessionId, logicalSessionId,
          originalOnly, stateRoot: options.stateRoot, homeRoot: registered.homeRoot, workspaceRoot: options.workspaceRoot ?? workspaceRootDefault(), projection,
          workspaceNames: new Map((repository.database.prepare('SELECT id,name FROM logical_workspaces WHERE deleted_at IS NULL').all() as { id: string; name: string }[])
            .map(row => [row.id, row.name])) });
        const policies = new SqliteInstanceWorkspacePolicyRepository(repository.database);
        if (!policies.workspaceSelected(policies.getPolicy(id), snapshot.workspaceId))
          throw new IntegrationError('SESSION_NOT_SYNCED', '目标工作区不在当前同步范围。');
        await ensurePlatformSessionBinding({ repository, ...dshSessionBinding(id, sessionId), logicalSessionId, checkOnly: true });
        const pluginData = await readHostPluginData({ stateRoot: options.stateRoot, instanceId: id, profileId: registered.profileId,
          homeRoot: registered.homeRoot, sessionId });
        await reconcileEndpointSession(canonicalEngine.store, snapshot);
        canonicalProjectionSource.pluginData.retain(logicalSessionId, pluginData);
        await ensurePlatformSessionBinding({ repository, ...dshSessionBinding(id, sessionId), logicalSessionId });
        return logicalSessionId;
      };
      return commitEndpointSessionChange({ endpointId, command,
      acceptsIdentity: async (id, sessionId, logicalSessionId) => {
        if (projectedLogicalSessionId(sessionId) === undefined) return true;
        const snapshot = await canonicalProjectionSource.loadSessions(writeBackRunIdentity(id, command.profileId), [logicalSessionId as never]);
        const item = snapshot.sessions.find(row => row.session.id === logicalSessionId);
        // A legacy mirror of an endpoint's own original must not overwrite its archive/delete state.
        return item === undefined || String(v3EndpointSessionId(item, snapshot.run)) === sessionId;
      },
      resolve: async (id, sessionId) => {
        const projected = projectedLogicalSessionId(sessionId);
        if (projected !== undefined) {
          if (!repository.database.prepare('SELECT id FROM logical_sessions WHERE id=?').get(projected))
            throw new IntegrationError('SYNC_PROJECTION_SOURCE_MISSING', '此会话属于旧映射，真源身份不可用，未重复导入。', 409);
          return projected;
        }
        return (await repository.findBinding(dshSessionBinding(id, sessionId).key))?.logicalSessionId
          ?? (await new SqliteSessionAliasRepository(repository.database).resolve('dsh-session', id, sessionId))?.target.logicalSessionId ?? undefined;
      },
      selected: (id, logicalSessionId) => {
        const row = repository.database.prepare(`SELECT m.workspace_id FROM logical_sessions s LEFT JOIN workspace_memberships m
          ON m.logical_session_id=s.id WHERE s.id=?`).get(logicalSessionId) as { workspace_id: LogicalWorkspaceId | null } | undefined;
        const policies = new SqliteInstanceWorkspacePolicyRepository(repository.database);
        return row !== undefined && policies.workspaceSelected(policies.getPolicy(id), row.workspace_id);
      },
      update: (id, patch) => composedEngine!.sessionCommands.updateSession(id, patch),
      remove: id => composedEngine!.sessionCommands.deleteSession(id),
      refresh,
      refreshDiscovered: async (id, sessionId, existingId) => {
        if (projectedLogicalSessionId(sessionId) !== undefined) return false;
        try { await refresh(id, sessionId, existingId, true); return true; }
        catch (error) { if ((error as { code?: string }).code === 'SYNC_DISCOVERY_EXISTING_UNVERIFIED') return false; throw error; }
      },
    });
    });
  const extensionAdapters = [...(options.extensionAdapters ?? builtInExtensionAdapters).filter(adapter => !installedAdapters.entries.some(entry => entry.kind === 'business' && entry.namespace === adapter.namespace)), ...installedAdapters.business];
  const sessionLifecycle = new SessionLifecycle(options.sessionLifecycleAdapters ?? knowledgeLifecycleAdapters(repository.database, extensionAdapters));
  await writes.run("session-lifecycle-initialize", () => {
    const rows = repository.database.prepare('SELECT id,archived_at,tombstoned_at FROM logical_sessions')
      .all() as { id: string; archived_at: string | null; tombstoned_at: string | null }[];
    sessionLifecycle.initialize(rows.map(row => ({ logicalSessionId: row.id, archivedAt: row.archived_at, deleted: row.tombstoned_at !== null })));
  });
  const resolveSourceAdapter: SourceAdapterResolver = event => adapterRegistry.list().flatMap(item => { const adapter = adapterRegistry.resolveRuntimeAdapter(item.manifest.id); return adapter ? [adapter] : []; }).find(owner => event.id.startsWith(`${owner.manifest.id}:`) || (typeof event.content === "object" && event.content !== null && !Array.isArray(event.content) && typeof (event.content as Readonly<Record<string, unknown>>).sourceKind === "string" && String((event.content as Readonly<Record<string, unknown>>).sourceKind).startsWith(`${owner.manifest.id}/`)));
  const canonicalEngine = coordinateAsyncMethods(new CanonicalSessionEngine(
    new SqliteCanonicalSessionEngineStore(repository.database, objectStore, writes,
      session => sessionLifecycle.changed({ logicalSessionId: session.id, archivedAt: session.archivedAt, deleted: session.tombstonedAt !== null }), instanceWorkspaceRuntime.assertMutationAllowed),
  ), ["observeCodex", "retitleCodexMirror", "appendDsh", "importDshNative", "tombstone", "restore"], writes, "canonical-commit");
  const codexProjectMapping = new CodexProjectMappingService({ database: repository.database, writes, instances,
    ...(options.fixturePolicy === undefined ? {} : { fixtureGuard: options.fixturePolicy }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const createCodexImports = (projectScope: CodexCanonicalImportOptions["projectScope"]) => new CodexImportService({
    instances, adapters: readAdapters, canonicalEngine, writes,
    ...(projectScope === undefined ? {} : { projectScope }),
    projectPort: new SqliteCodexProjectPort(new SqliteCanonicalRepository(repository.database)),
    evidencePort: evidenceStore,
    ...(options.fixturePolicy === undefined ? {} : { fixtureGuard: options.fixturePolicy }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const projectScope: NonNullable<CodexCanonicalImportOptions["projectScope"]> = instance => codexProjectMapping.readScope(instance);
  const codexImports = createCodexImports(projectScope);
  const codexProjectObserver = new CodexProjectObserver({ instances, projectScope, importService: codexImports,
    allowed: async () => (await codexMirror.check()).active.background && codexMirror.status().active.mirror,
    selectedInstanceId: () => codexMirror.status().preferences.instanceId,
    onStatus: status => { codexProjectMapping.setObserverStatus(status); },
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
  const businessPages = await BusinessPageRegistry.create({stateRoot:options.stateRoot,writes});
  const extensionStore = new SqliteExtensionRepository(repository.database);
  const readExtensionVersion = (sessionId: import("@linmu/dsh-session-contracts").LogicalSessionId, versionId: import("@linmu/dsh-session-contracts").SessionVersionId) => canonicalProjectionSource.loadVersionEvents(sessionId, versionId);
  composedEngine = new SessionMaintenanceEngine({
    readerProvider: nativeReaderProvider,
    businessPages,
    instanceWorkspace: instanceWorkspaceRuntime.createService(),
    adapterCatalog,
    sessionLifecycle,
    extensions: new ExtensionDataService(extensionStore, extensionAdapters, readExtensionVersion, { ...lynnExtensionHooks(extensionStore), refresh: async query => { if (query.namespace === "gpt-compat" || query.adapterId === "gpt-compat") await synchronizeGptIndex(extensionStore, readExtensionVersion); } }),
    codexProjectMapping,
    codexProjectObserver,
    codexMirror,
    beforeProjectionPrepare: async () => {
      if (!codexMirror.status().preferences.mirror) return;
      if (!(await codexMirror.check()).active.mirror) return;
      await codexProjectMapping.activateForStartup(async policy => {
        const importer = createCodexImports(instance => codexProjectMapping.readScope(instance, policy));
        const instanceIds = instances.filter(instance => instance.platform === 'codex' && instance.id === codexMirror.status().preferences.instanceId).map(instance => instance.id);
        if (instanceIds.length > 0) await importer.run({ operationId: `mapping-startup-${crypto.randomUUID()}`, instanceIds, mode: "content" });
      });
      codexImports.clearChangeCache();
    },
    integrations: options.hostIntegrations === false ? undefined : new InstanceIntegrationService({
      recoveryRuns: scopedRecoveryRuns,
      stateRoot: options.stateRoot, writes,
      discover: async () => {
        const sources = await withDefaultCodexSource(instances, defaultCodexHome);
        const discovered = await discoverLauncherIntegrations(options.integrationEnvironment?.launcherDataRoot ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "in.dsh-plug.dsh-launcher"), sources, instance => codexReader.probe(instance));
        discovered.targets.push(...await discoverStandaloneInstances(options.stateRoot));
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
        await adapterRegistry.select({ environment: { dshVersion: target.target.version, packageVersions: target.packageVersions, runtimeCapabilities: target.runtimeCapabilities ?? ["sessionPersistence", "session/event", "session/flush"] }, ...(target.target.adapterId === null ? {} : { pinnedAdapterId: target.target.adapterId as never }) });
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
      ...(options.pickInstanceFolder === undefined ? {} : { pickInstanceFolder: options.pickInstanceFolder }),
      // Takeover: the Engine prepares the run itself, exactly as a Launcher
      // launch would, and publishes the handoff for the running instance to
      // claim. Nothing here relaxes the run's own preconditions — a run the
      // lifecycle refuses to prepare is a takeover that does not happen.
      prepareTakeover: async (target, inspection) => {
        if (target.target.profile === null || inspection.runtimeUrl === null) return null;
        const prepared = await composedEngine!.prepareProjectionRuntimeRun(takeoverPrepareRequest(target, inspection));
        return { schemaVersion: 1, ticketId: `takeover-${randomUUID()}`, instanceId: target.instanceId,
          profileId: target.target.profile, runId: prepared.runId, runtimeClientId: prepared.runtimeClientId,
          ownerClientId: `takeover-owner-${randomUUID()}`, temporaryPersistenceRootId: prepared.temporaryPersistenceRootId,
          maintenanceEndpoint: inspection.runtimeUrl, dshVersion: target.target.version,
          adapterId: prepared.adapterId, nativeMode: prepared.nativeMode ?? null,
          createdAt: new Date().toISOString(), claimedAt: null };
      },
      // Joining a workspace is the instance-side entry asking the Engine to map
      // that workspace's existing sessions into Maintenance's own storage. The
      // directory is derived from the instance's Home and the workspace path, so
      // the instance never sends a location the Engine just obeys.
      mapWorkspace: async ({ target, request }) => writes.run('join-workspace', async () => {
        const source = createWorkspaceSourceForHome({ homeRoot: target.homeRoot, workspacePath: request.workspacePath, instanceId: request.instanceId,
          logicalSessionId: nativeSessionId => mappedLogicalSessionId(request.instanceId, nativeSessionId) });
        const mapped = await mapJoinedWorkspace({ engine: canonicalEngine, instanceId: request.instanceId,
          capturePluginData: async (sessionId, logicalSessionId) => canonicalProjectionSource.pluginData.retain(logicalSessionId,
            await readHostPluginData({ stateRoot: options.stateRoot, instanceId: request.instanceId, profileId: request.profileId,
              homeRoot: target.homeRoot, sessionId })),
          bindIdentity: (nativeSessionId, logicalSessionId, checkOnly) => ensurePlatformSessionBinding({ repository,
            ...dshSessionBinding(request.instanceId, nativeSessionId), logicalSessionId, checkOnly }),
          workspaceKey: request.workspaceId, workspaceName: request.workspaceName, source,
          workspaces: {
            // Reading the folder row is a plain lookup against the same table the
            // board reads, so no second notion of a workspace is introduced.
            read: async (id: LogicalWorkspaceId) => repository.database.prepare(
              `SELECT id, parent_id AS parentId, name, sort_key AS sortKey, deleted_at AS deletedAt,
                 created_at AS createdAt, updated_at AS updatedAt FROM logical_workspaces WHERE id = ?`)
              .get(id) as unknown as LogicalWorkspace | undefined,
            upsert: async (workspace: LogicalWorkspace) => new SqliteCanonicalRepository(repository.database).upsertLogicalWorkspace(workspace),
          } });
        await rememberJoinedWorkspace({ stateRoot: options.stateRoot, endpointId: request.instanceId,
          homeRoot: target.homeRoot, workspaceId: mapped.workspaceId, path: request.workspacePath });
        await instanceWorkspaceRuntime.enrollWorkspace(request.instanceId, mapped.workspaceId);
        return { workspaceId: mapped.workspaceId as unknown as string, created: mapped.created,
          mapped: mapped.mapped.map(String), alreadyPresent: mapped.alreadyPresent, failures: mapped.failures };
      }),
    }),
    workspaceSync: new WorkspaceSyncPolicyService({ stateRoot: options.stateRoot, writes, directory: () => new SessionMaintenanceQueries(repository.database).readCanonicalWorkspaceDirectory() }),
    instances,
    adapters: readAdapters,
    repository,
    objectStore,
    continuations,
    learningTargets: registeredCodexTargets(config),
    canonicalEngine,
    writes,
    codexImports,
    retention,
    resolveProjectionAdapter: (adapterId) => adapterRegistry.resolveRuntimeAdapter(adapterId),
    projectionSourceFor: adapterId => {
      const adapter=adapterRegistry.resolveRuntimeAdapter(adapterId);
      if(!adapter)throw new TypeError(`Unsupported projection adapter: ${adapterId}`);
      return sourceWithEvidence(canonicalProjectionSource,adapter,evidenceStore,resolveSourceAdapter);
    },
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
        resolveSourceAdapter,
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
  if (extensionAdapters.some(adapter => adapter.panelAdapter?.id === "lynn")) attachLynn(composedEngine, extensionStore);
  return composedEngine;
  } catch (error) { closeRepository?.(); writes.close(); throw error; }
}

export function createReadOnlyComposition(options: CompositionOptions): Promise<SessionMaintenanceEngine> {
  return createComposition(options, []);
}

export function createDshWritableComposition(options: DshWritableCompositionOptions): Promise<SessionMaintenanceEngine> {
  if (options.dshGatewayTargets.length === 0) throw new TypeError("Writable composition requires at least one DSH Core gateway target");
  return createComposition(options, options.dshGatewayTargets);
}
