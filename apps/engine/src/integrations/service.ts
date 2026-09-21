import { maintenanceRequired, setMaintenanceRequired } from "./maintenance-policy.js";
import { scopedRecoveryRuns } from '../lifecycle-recovery.js';
import type { MaintenanceWriteScope, IntegrationAction, IntegrationDirectory, IntegrationTarget } from "@linmu/dsh-session-contracts";
import { CODEX_NATIVE_SYNC_UNAVAILABLE } from "@linmu/dsh-session-contracts";
import { IntegrationError, readIntegrationBindings, saveIntegrationBindings } from "./bindings.js";
import type { DiscoveredIntegration, DiscoveredIntegrations } from "./launcher-discovery.js";
import { classifyIntegrationConnectionKind, resolveBindingConnectionKind } from "./launcher-discovery.js";
import { configureLauncherHook, desiredLauncherHook, launcherHookPath, launcherHooksEqual, installIntegrationPlugin, type IntegrationInstallOptions } from "./launcher-install.js";
import { readJsonIfPresent, writeJsonAtomically } from "./bindings.js";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { saveStandaloneInstance } from './standalone.js';
import type { InstanceFolderPicker, InstanceFolderSelection } from '../instance-folder.js';
import { createWindowsInstanceFolderPicker, selectInstanceFolder } from '../instance-folder.js';
import { randomUUID } from 'node:crypto';
import { challengeInstanceLiveness, claimTakeoverHandoff, inspectInstanceLease, listPendingSyncRequests,
  listTakeoverHandoffs, recordSyncDecision, writeSyncRequest, writeTakeoverHandoff } from '../instance-lease.js';
import { workspaceJoinReceiptSchema } from '@linmu/dsh-session-contracts';
import type { InstanceLeaseInspection, InstanceSyncDecisionResponse, StandaloneInstance, TakeoverClaimRequest,
  TakeoverHandoff, WorkspaceJoinReceipt, WorkspaceJoinRequest } from '@linmu/dsh-session-contracts';

const displayCatalogSchema = z.object({ instances: z.array(z.object({ id: z.string(), name: z.string() })) });

export interface IntegrationServiceOptions {
  readonly stateRoot: string;
  readonly writes: MaintenanceWriteScope;
  readonly discover: () => Promise<DiscoveredIntegrations>;
  readonly installation: IntegrationInstallOptions;
  readonly verifyAdapter: (target: DiscoveredIntegration) => Promise<void>;
  /** Runs within the same writer scope, before a successful binding can be published. */
  readonly registerSource?: (target: DiscoveredIntegration) => Promise<void>;
  /**
   * How the operator chooses the instance's DSH Home folder. Injectable so a
   * caller (and a test) never has to open the native dialog, and so a headless
   * deployment can refuse the interaction explicitly instead of hanging on it.
   */
  readonly pickInstanceFolder?: InstanceFolderPicker;
  /**
   * Turns a verified running instance into an Engine-prepared run and returns
   * the handoff the instance claims. Injected because only the composition root
   * can reach the Runtime Broker and the Canonical store; this service owns the
   * decision about *whether* a takeover may happen, not the run itself.
   */
  readonly prepareTakeover?: (target: DiscoveredIntegration, inspection: InstanceLeaseInspection) => Promise<TakeoverHandoff | null>;
  /**
   * Maps a workspace the user asked to join into Maintenance's own storage.
   * Injected because only the composition root can reach the canonical store.
   */
  readonly mapWorkspace?: (input: { readonly target: DiscoveredIntegration; readonly request: WorkspaceJoinRequest }) =>
    Promise<{ readonly workspaceId: string; readonly created: boolean; readonly mapped: readonly string[];
      readonly alreadyPresent: readonly unknown[]; readonly failures: readonly { nativeSessionId: string; reason: string }[] }>;
  readonly clock?: () => string;
  readonly recoveryRuns?: typeof scopedRecoveryRuns;
}

/** Coordinates onboarding while keeping slow package installs outside the canonical writer queue. */
export class InstanceIntegrationService {
  private readonly installing = new Set<string>();
  private readonly generations = new Map<string, number>();
  private displayNames: { expiresAt: number; value: Promise<ReadonlyMap<string, string>> } | undefined;
  constructor(private readonly options: IntegrationServiceOptions) {}

  async registerStandalone(config: StandaloneInstance): Promise<IntegrationDirectory> {
    const target = await this.options.writes.run('instance-configuration', async () => {
      const bindings = await readIntegrationBindings(this.options.stateRoot);
      if (bindings.some(item => item.instanceId === config.instanceId && item.profileId === config.profileId))
        throw new IntegrationError('INSTANCE_ALREADY_REGISTERED', '该实例已注册；更改路径前请正常停止并解除注册。');
      return saveStandaloneInstance(this.options.stateRoot, config);
    });
    return this.action(target.target.id, 'connect');
  }

  /**
   * Connect by folder: ask for the instance's DSH Home, then report what is in
   * it. This step is deliberately read-only, so a cancelled or unusable choice
   * leaves no binding, no Launcher hook and no startup gate behind; registering
   * the inspected Home is a separate, explicit confirmation.
   */
  async selectInstanceFolder(signal: AbortSignal): Promise<InstanceFolderSelection> {
    return selectInstanceFolder(this.options.pickInstanceFolder ?? createWindowsInstanceFolderPicker(), signal);
  }

  /**
   * Detect whether the instance behind a selected folder is running right now.
   *
   * Detection is a separate question from connection: a bound instance can be
   * stopped, and a stopped instance cannot be taken over. The answer is built
   * from the instance's own handshake plus OS evidence, never from Launcher
   * state, which is what makes a directory connection independent of Launcher.
   */
  async inspectInstanceTakeover(targetId: string): Promise<{ readonly target: IntegrationTarget; readonly lease: InstanceLeaseInspection }> {
    const { target, lease } = await this.resolveTakeoverTarget(targetId);
    return { target: target.target, lease };
  }

  private async resolveTakeoverTarget(targetId: string): Promise<{ target: DiscoveredIntegration; lease: InstanceLeaseInspection }> {
    const found = (await this.options.discover()).targets.find(item => item.target.id === targetId);
    if (found === undefined) throw new IntegrationError('INTEGRATION_NOT_FOUND', '接入对象已不存在，请刷新实例列表。', 404);
    if (found.target.kind !== 'dsh' || found.target.profile === null)
      throw new IntegrationError('INSTANCE_TAKEOVER_UNSUPPORTED', '只有具体配置的 DSH 实例才能被接管。');
    const lease = await inspectInstanceLease(this.options.stateRoot, { instanceId: found.instanceId,
      profileId: found.target.profile, expectedHomeRoot: found.homeRoot, profileRoot: found.profileRoot });
    return { target: found, lease };
  }

  /**
   * Ask the running instance's user to approve a synchronisation.
   *
   * The Engine cannot synchronise an already running instance by itself: the
   * plugin's persistence root was fixed when the instance started. So the Engine
   * states what it wants and waits for the instance to put the question to its
   * user. Writing the request is the whole action — no work happens here, and an
   * unanswered or refused request leaves everything untouched.
   */
  async requestInstanceSync(targetId: string, summary: string): Promise<{ readonly requestId: string;
    readonly instanceId: string; readonly profileId: string }> {
    const { target, lease } = await this.resolveTakeoverTarget(targetId);
    if (lease.decision !== 'running' || lease.runtimeUrl === null)
      throw new IntegrationError('INSTANCE_NOT_RUNNING', lease.reason);
    const requestId = `sync-${randomUUID()}`;
    await writeSyncRequest(this.options.stateRoot, { schemaVersion: 1, requestId, instanceId: target.instanceId,
      profileId: target.target.profile!, summary, requestedAt: (this.options.clock ?? (() => new Date().toISOString()))() });
    return { requestId, instanceId: target.instanceId, profileId: target.target.profile! };
  }

  /** Requests this instance has not answered yet, for the instance to surface. */
  async listPendingInstanceSync(instanceId: string, profileId: string) {
    return listPendingSyncRequests(this.options.stateRoot, instanceId, profileId);
  }

  /** Record the user's answer; the first answer is final. */
  async decideInstanceSync(decision: InstanceSyncDecisionResponse): Promise<InstanceSyncDecisionResponse> {
    const recorded = await recordSyncDecision(this.options.stateRoot, decision);
    if (!recorded.recorded) throw new IntegrationError('INSTANCE_SYNC_DECISION_REFUSED', recorded.reason, 409);
    return decision;
  }

  /**
   * Take over an already running instance.
   *
   * The Engine drives this: it verifies the instance first, then prepares its own
   * run, and only then publishes a handoff for the instance to claim. Nothing is
   * relaxed for the sake of the takeover — the run still comes from the normal
   * projection lifecycle, and an instance that cannot prove it is the running
   * instance simply does not get one.
   */
  async takeoverInstance(targetId: string): Promise<{ readonly target: IntegrationTarget; readonly lease: InstanceLeaseInspection;
    readonly handoff: TakeoverHandoff | null }> {
    const { target, lease } = await this.resolveTakeoverTarget(targetId);
    if (lease.decision !== 'running' || lease.process === null || lease.runtimeUrl === null)
      throw new IntegrationError('INSTANCE_NOT_RUNNING', lease.reason);
    // The lease says an instance was started; the instance itself has to agree.
    const challenged = await challengeInstanceLiveness({ runtimeUrl: lease.runtimeUrl, instanceId: target.instanceId,
      profileId: target.target.profile!, pid: lease.process.pid, homeRoot: target.homeRoot });
    if (!challenged.answered) throw new IntegrationError('INSTANCE_HANDSHAKE_REFUSED', challenged.reason);
    if (this.options.prepareTakeover === undefined)
      throw new IntegrationError('INSTANCE_TAKEOVER_UNAVAILABLE', '此引擎尚未配置接管运行通道。', 503);
    const prepared = await this.options.prepareTakeover(target, lease);
    if (prepared === null) throw new IntegrationError('INSTANCE_NOT_RUNNING', lease.reason);
    await writeTakeoverHandoff(this.options.stateRoot, prepared);
    return { target: target.target, lease, handoff: prepared };
  }

  /**
   * Hand the prepared run to the instance that presents the ticket.
   *
   * The ticket is single-use and bound to one instance: a claimed ticket is
   * never returned again, so a restarted instance cannot attach the same run
   * twice, and a wrong instance cannot steal a run prepared for another.
   */
  async claimTakeoverHandoff(input: TakeoverClaimRequest): Promise<TakeoverHandoff> {
    const claimed = await claimTakeoverHandoff(this.options.stateRoot, input);
    if (!claimed.claimed) throw new IntegrationError('INSTANCE_TAKEOVER_REFUSED', claimed.reason, 409);
    return claimed.handoff;
  }

  /**
   * Prepared runs still waiting for their instance.
   *
   * The instance polls this while the Engine is up: the tickets live in the
   * Engine's own directory, and only a caller presenting this instance's
   * identity learns that a run was prepared for it. Claimed tickets are
   * omitted, which is what makes the poll idempotent instead of attaching the
   * same run over and over.
   */
  async listPendingTakeovers(instanceId: string, profileId: string): Promise<readonly TakeoverHandoff[]> {
    return (await listTakeoverHandoffs(this.options.stateRoot))
      .filter(handoff => handoff.instanceId === instanceId && handoff.profileId === profileId && handoff.claimedAt === null);
  }

  /**
   * Join one workspace into Maintenance's own storage, on the instance's request.
   *
   * The instance only states which workspace it is and where its sessions live;
   * the Engine maps them, because reading an instance's sessions and writing
   * canonical rows are both its jobs. Joining only ever happens because a user
   * asked for it through the entry: nothing here enrols a workspace by itself.
   */
  async joinWorkspace(input: WorkspaceJoinRequest): Promise<WorkspaceJoinReceipt> {
    if (this.options.mapWorkspace === undefined)
      throw new IntegrationError('WORKSPACE_JOIN_UNAVAILABLE', '此引擎尚未配置工作区映射。', 503);
    const found = (await this.options.discover()).targets.find(item => item.instanceId === input.instanceId
      && item.target.profile === input.profileId);
    if (found === undefined) throw new IntegrationError('INTEGRATION_NOT_FOUND', '该实例尚未接入，无法加入工作区。', 404);
    if (found.homeRoot.length === 0) throw new IntegrationError('INSTANCE_PATH_INVALID', '该实例没有可读取的 DSH Home。');
    const receipt = await this.options.mapWorkspace({ target: found, request: input });
    return workspaceJoinReceiptSchema.parse({ workspaceId: receipt.workspaceId, created: receipt.created,
      mapped: [...receipt.mapped], alreadyPresent: receipt.alreadyPresent.map(String),
      failures: receipt.failures.map(failure => ({ ...failure })) });
  }

  /** Presentation only: read the bound Launcher catalog, without attestation or runtime discovery. */
  async instanceDisplayName(instanceId: string, profileId: string): Promise<string | undefined> {
    if (!this.displayNames || this.displayNames.expiresAt <= Date.now()) {
      this.displayNames = { expiresAt: Date.now() + 5000, value: this.readDisplayNames().catch(() => new Map<string, string>()) };
    }
    return (await this.displayNames.value).get(JSON.stringify([instanceId, profileId]));
  }

  private async readDisplayNames(): Promise<ReadonlyMap<string, string>> {
    const bindings = (await readIntegrationBindings(this.options.stateRoot)).filter(binding =>
      binding.kind === "dsh" && binding.launcherDataRoot !== null && binding.profileId !== null);
    const catalogs = new Map(await Promise.all([...new Set(bindings.map(binding => binding.launcherDataRoot!))].map(async root => {
      const names = new Map<string, string>();
      try {
        const catalog = displayCatalogSchema.safeParse(await readJsonIfPresent(join(root, "config.json")));
        if (catalog.success && new Set(catalog.data.instances.map(instance => instance.id)).size === catalog.data.instances.length) {
          for (const instance of catalog.data.instances) {
            const name = instance.name.trim();
            if (name && name.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(name)) names.set(instance.id, name);
          }
        }
      } catch { /* A missing display label must not hide otherwise readable extension data. */ }
      return [root, names] as const;
    })));
    const candidates = new Map<string, Set<string>>();
    for (const binding of bindings) {
      const name = catalogs.get(binding.launcherDataRoot!)?.get(binding.instanceId);
      if (name === undefined) continue;
      const key = JSON.stringify([binding.instanceId, binding.profileId]);
      const names = candidates.get(key) ?? new Set<string>(); names.add(name); candidates.set(key, names);
    }
    return new Map([...candidates].flatMap(([key, names]) => names.size === 1 ? [[key, [...names][0]!] as const] : []));
  }

  async list(): Promise<IntegrationDirectory> {
    this.displayNames = undefined;
    const [discovery, bindings] = await Promise.all([this.options.discover(), readIntegrationBindings(this.options.stateRoot)]);
    const targets = await Promise.all(discovery.targets.map(async item => {
      const target: IntegrationTarget = { ...item.target, capabilities: item.target.capabilities.map(capability => ({ ...capability })), issues: [...item.target.issues] };
      const binding = bindings.find(bound => bound.targetId === target.id);
      if (binding !== undefined) {
        const connectionKind = resolveBindingConnectionKind(binding);
        let hookReady = target.kind === "codex" && item.codexRegistered !== false;
        // Only a Launcher connection owns an external-lifecycle hook. A
        // directory connection must reach `connected` without one, and a legacy
        // record without a Launcher root keeps the behaviour it already had.
        if (target.kind === "dsh" && (connectionKind === "directory" || item.launcherDataRoot === null)) hookReady = true;
        if (target.kind === "dsh" && connectionKind !== "directory" && item.launcherDataRoot !== null) {
          try { hookReady = launcherHooksEqual(await readJsonIfPresent(launcherHookPath(item)), await desiredLauncherHook(item, this.options.installation)); }
          catch { hookReady = false; }
        }
        target.status = target.status !== "unsupported" && binding.fingerprint === item.fingerprint && item.pluginReady && hookReady ? "connected" : "needs-attention";
        if (target.status === "needs-attention") target.issues.push("实例或接入配置发生变化，请修复接入后再启动。");
        const lifecycle = target.capabilities.find(capability => capability.id === "lifecycle");
        if (lifecycle !== undefined) { lifecycle.status = target.status === "connected" ? "supported" : "unavailable"; lifecycle.detail = target.status === "connected" ? "已保存此实例及配置的启动绑定；运行连接在启动后建立。" : "启动绑定需要重新验证。"; }
      }
      return target;
    }));
    for (const binding of bindings) {
      if (targets.some(item => item.id === binding.targetId)) continue;
      targets.push({ id: binding.targetId, kind: binding.kind, name: "已不可用的接入", version: binding.runtimeVersion, profile: binding.profileId, status: "needs-attention", adapterId: binding.adapterId, capabilities: [], issues: ["原实例已移除或来源目录不可用，可以断开此接入；会话数据保留。"] });
    }
    return { targets, launcherDetected: discovery.launcherDetected, nativeSyncSupported: false, nativeSyncReason: CODEX_NATIVE_SYNC_UNAVAILABLE };
  }

  async action(targetId: string, action: IntegrationAction): Promise<IntegrationDirectory> {
    this.displayNames = undefined;
    if (action === "disconnect") {
      this.generations.set(targetId, (this.generations.get(targetId) ?? 0) + 1);
      await this.options.writes.run("integration-disconnect", async () => {
        const bindings = await readIntegrationBindings(this.options.stateRoot);
        const current = bindings.find(item => item.targetId === targetId);
        if (current?.kind === 'dsh' && current.profileId !== null) {
          const runs = await (this.options.recoveryRuns ?? scopedRecoveryRuns)(this.options.stateRoot, current.instanceId, current.profileId);
          if (runs.some(run => !['closed', 'recovered'].includes(run.state)))
            throw new IntegrationError('INTEGRATION_DRAIN_REQUIRED', '请先正常停止实例并完成未确认操作的恢复；取得收尾回执后才能解除注册。');
        }
        await saveIntegrationBindings(this.options.stateRoot, bindings.filter(item => item.targetId !== targetId));
        const disconnected = bindings.find(item => item.targetId === targetId);
        // Only a connection that owns the instance-side startup gate clears it;
        // a directory connection never wrote one and must not create the file.
        if(disconnected?.kind === "dsh" && disconnected.profileId !== null
          && await maintenanceRequired(this.options.stateRoot, disconnected.instanceId, disconnected.profileId))
          await setMaintenanceRequired(this.options.stateRoot,disconnected.instanceId,disconnected.profileId,false);
      });
      return this.list();
    }
    // Capture intent before discovery can yield to a later disconnect.
    let generation = this.generations.get(targetId) ?? 0;
    const assertCurrent = () => {
      if ((this.generations.get(targetId) ?? 0) !== generation) throw new IntegrationError("INTEGRATION_CANCELLED", "接入已被断开或被后续操作替代，未启用该实例。");
    };
    const before = (await this.options.discover()).targets.find(item => item.target.id === targetId);
    if (before === undefined) throw new IntegrationError("INTEGRATION_NOT_FOUND", "接入对象已不存在，请刷新实例列表。", 404);
    if (action === "check") {
      if (before.target.status !== "unsupported") await this.options.verifyAdapter(before);
      return this.list();
    }
    assertCurrent();
    if (before.target.status === "unsupported") throw new IntegrationError("INTEGRATION_UNSUPPORTED", before.target.issues.join(" "));
    const installKey = before.profileRoot ?? before.homeRoot;
    if (this.installing.has(installKey)) throw new IntegrationError("INTEGRATION_BUSY", "此配置正在接入或修复，请等待当前操作完成。");
    this.installing.add(installKey);
    generation += 1;
    this.generations.set(targetId, generation);
    try {
      // A directory connection must not require anything of the instance at
      // launch, so it neither installs the Launcher hook nor the instance-side
      // startup gate; a Launcher connection keeps both steps unchanged.
      const keeping = classifyIntegrationConnectionKind(before.launcherDataRoot) !== "directory";
      if (keeping && before.target.kind === "dsh" && before.launcherDataRoot !== null) {
        await desiredLauncherHook(before, this.options.installation); // Reject another provider before installing anything.
        await installIntegrationPlugin(before, this.options.installation);
      }
      assertCurrent();
      const after = (await this.options.discover()).targets.find(item => item.target.id === targetId);
      if (after === undefined || after.homeRoot !== before.homeRoot || after.profileRoot !== before.profileRoot || after.versionRoot !== before.versionRoot || after.target.version !== before.target.version) {
        throw new IntegrationError("INTEGRATION_TARGET_CHANGED", "安装期间实例发生变化，未启用接入。请重新检查。");
      }
      if (after.target.status === "unsupported" || !after.pluginReady) throw new IntegrationError("INTEGRATION_VERIFY_FAILED", "组件安装后尚未通过检查，未启用接入。请修复后重试。");
      await this.options.verifyAdapter(after);
      assertCurrent();
      await this.options.writes.run("integration-connect", async () => {
        const current = (await this.options.discover()).targets.find(item => item.target.id === targetId);
        if (current?.fingerprint !== after.fingerprint) throw new IntegrationError("INTEGRATION_TARGET_CHANGED", "实例在验证后发生变化，未保存启动绑定。");
        assertCurrent();
        const bindings = await readIntegrationBindings(this.options.stateRoot);
        const hookPath = keeping && after.target.kind === "dsh" && after.launcherDataRoot !== null ? launcherHookPath(after) : null;
        const oldHook = hookPath === null ? undefined : await readJsonIfPresent(hookPath);
        let publishedHook: unknown;
        try {
          await this.options.registerSource?.(after);
          assertCurrent();
          if (hookPath !== null) { await configureLauncherHook(after, this.options.installation); publishedHook = await readJsonIfPresent(hookPath); }
          assertCurrent();
          if (keeping && after.target.kind === "dsh" && after.target.profile !== null) await setMaintenanceRequired(this.options.stateRoot,after.instanceId,after.target.profile,true);
          await saveIntegrationBindings(this.options.stateRoot, [...bindings.filter(item => item.targetId !== targetId), {
            targetId, kind: after.target.kind, instanceId: after.instanceId, profileId: after.target.profile,
            connectionKind: classifyIntegrationConnectionKind(after.launcherDataRoot),
            launcherDataRoot: after.launcherDataRoot, runtimeVersion: after.target.version, adapterId: after.target.adapterId,
            fingerprint: after.fingerprint, checkedAt: (this.options.clock ?? (() => new Date().toISOString()))(),
          }]);
        } catch (error) {
          if (hookPath !== null && publishedHook !== undefined && JSON.stringify(await readJsonIfPresent(hookPath)) === JSON.stringify(publishedHook)) {
            if (oldHook === undefined) await unlink(hookPath);
            else await writeJsonAtomically(hookPath, oldHook);
          }
          throw error;
        }
      });
    } finally { this.installing.delete(installKey); }
    return this.list();
  }
}
