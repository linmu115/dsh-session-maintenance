import {
  instanceWorkspaceConfigurationSchema, instanceWorkspaceEffectiveScopeSchema, instanceSessionAvailabilitySchema,
  instanceWorkspaceInstanceDirectorySchema, instanceWorkspaceInstanceIdSchema, instanceWorkspacePolicyUpdateSchema,
  type InstanceWorkspaceConfiguration, type InstanceWorkspaceEffectiveScope, type InstanceSessionAvailability,
  type InstanceWorkspaceInstanceDirectory, type InstanceWorkspacePolicyUpdate,
} from "@linmu/dsh-session-contracts";
import { IntegrationError } from '@linmu/dsh-session-contracts';
import { EndpointSyncCoordinator } from './endpoint-sync.js';
import type { EndpointSyncCommand, EndpointSyncReceipt } from '@linmu/dsh-session-contracts';

export interface InstanceWorkspacePorts {
  exclusive?: <T>(work: () => Promise<T>) => Promise<T>;
  policyRevision?: (endpointId: string) => number;
  validateProfile?: (endpointId: string, profileId: string) => Promise<void>;
  mutateSession?: (endpointId: string, command: EndpointSyncCommand) => Promise<Omit<EndpointSyncReceipt, 'epoch'>>;
  listInstances(): Promise<InstanceWorkspaceInstanceDirectory>;
  readConfiguration(instanceId: string): Promise<InstanceWorkspaceConfiguration>;
  writePolicy(instanceId: string, update: InstanceWorkspacePolicyUpdate): Promise<unknown>;
  readEffectiveScope(instanceId: string, profileId: string): Promise<InstanceWorkspaceEffectiveScope>;
  readSessionAvailability(instanceId: string, logicalSessionId: string, profileId: string): Promise<InstanceSessionAvailability>;
  /**
   * Hand the newly saved range to the instance itself.
   *
   * Saving a range only records what the operator wants; this is the step that actually puts the
   * selected workspaces' sessions into the instance's own session directory, so a refresh shows
   * them. It runs in a tracked background task after the policy is durable, so
   * a failure is reported independently without delaying the saved policy response.
   */
  syncToInstance?: (instanceId: string) => Promise<InstanceWriteBackSummary>;
  /**
   * The local folders the instance should own as its workspaces.
   *
   * Maintenance stores buckets; the instance can only show sessions under a *registered* workspace
   * whose path equals the session's `cwd`. The Engine creates the folders, and the instance
   * registers them, so the mapping is complete on both sides.
   */
  readWorkspaceFolders(instanceId: string): Promise<readonly { readonly name: string; readonly path: string }[]>;
  /**
   * The instances this Engine is registered with, for the alignment that happens at start.
   *
   * A saved range is a standing instruction for as long as it lasts, and the moment the Engine
   * starts is the moment the true source is authoritative: every registered instance's range is
   * made true in that instance before the operator reads either side as current. Only registered
   * (directory-connected) instances can be aligned — an instance with no directory has nowhere to
   * write, and one that was never registered must not be touched at all.
   */
  registeredInstances?: () => Promise<readonly string[]>;
}

/** What one write-back pass did, in the words the operator sees. */
export type InstanceWriteBackSummary = import('@linmu/dsh-session-contracts').WorkspaceWriteBackSummary;
/** Transport boundary only. The provider owns policy writes and active run snapshots. */
export class InstanceWorkspaceService {
  /** The last write-back this service performed, for the caller to report. */
  private readonly background = new Set<Promise<void>>();
  async close(): Promise<void> { await this.sync?.close(); await Promise.allSettled([...this.background]); }
  private lastWriteBack: InstanceWriteBackSummary | undefined;
  private readonly sync: EndpointSyncCoordinator | undefined;
  constructor(private readonly ports: InstanceWorkspacePorts) {
    if (ports.exclusive && ports.policyRevision && ports.mutateSession && ports.syncToInstance) {
      this.sync = new EndpointSyncCoordinator({ exclusive: ports.exclusive, revision: ports.policyRevision,
        align: ports.syncToInstance, commit: async (endpointId, command) => {
          await ports.validateProfile?.(endpointId, command.profileId);
          return ports.mutateSession!(endpointId, command);
        } });
    }
  }
  async syncStatus(endpointId: string, profileId: string) {
    await this.requireInstance(endpointId);
    await this.ports.validateProfile?.(endpointId, profileId);
    if (!this.sync) throw new IntegrationError('SYNC_UNAVAILABLE', '当前 adapter 未提供同步协议。', 503);
    this.sync.requestAlignment(endpointId);
    return this.sync.status(endpointId);
  }
  async syncChange(endpointId: string, command: EndpointSyncCommand): Promise<EndpointSyncReceipt> {
    await this.syncStatus(endpointId, command.profileId);
    return this.sync!.commit(endpointId, command);
  }
  private alignOne(endpointId: string) {
    return this.sync ? this.sync.align(endpointId) : this.ports.syncToInstance!(endpointId);
  }
  /** What the most recent successful save actually wrote into the instance. */
  writeBackSummary(): InstanceWriteBackSummary | undefined { return this.lastWriteBack; }
  async listInstances(): Promise<InstanceWorkspaceInstanceDirectory> {
    return instanceWorkspaceInstanceDirectorySchema.parse(await this.ports.listInstances());
  }
  private async requireInstance(instanceId: string): Promise<void> {
    instanceWorkspaceInstanceIdSchema.parse(instanceId);
    const directory = await this.listInstances();
    if (![...directory.instances, ...(directory.historicalInstances ?? [])].some(item => item.instanceId === instanceId))
      throw new IntegrationError("INSTANCE_WORKSPACE_INSTANCE_UNKNOWN", "未找到已登记的 DSH 实例，请重新读取实例目录。", 404);
  }
  async get(instanceId: string): Promise<InstanceWorkspaceConfiguration> {
    await this.requireInstance(instanceId);
    const value = instanceWorkspaceConfigurationSchema.parse(await this.ports.readConfiguration(instanceId));
    if (value.policy.instanceId !== instanceId) throw new IntegrationError("INSTANCE_WORKSPACE_SCOPE_MISMATCH", "实例范围返回了不同实例的配置。", 502);
    return { ...value, ...(this.sync ? { synchronization: this.sync.progress(instanceId) } : {}), pendingActivation: value.activeScopes.some(scope => scope.policyRevision !== value.policy.revision) };
  }
  async save(instanceId: string, input: InstanceWorkspacePolicyUpdate): Promise<InstanceWorkspaceConfiguration> {
    const update = instanceWorkspacePolicyUpdateSchema.parse(input);
    await this.requireInstance(instanceId);
    try { await this.ports.writePolicy(instanceId, update); }
    catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "INSTANCE_WORKSPACE_POLICY_CONFLICT") throw new IntegrationError(code, "同步范围已在别处修改，已请求重新读取；请核对后再次保存。", 409);
      if (code === "INSTANCE_WORKSPACE_UNKNOWN") throw new IntegrationError(code, "有工作区已移除或不存在，请刷新名单。", 409);
      throw error;
    }
    // Durable save acknowledgement does not wait for host I/O. The configuration carries progress.
    if (this.sync) this.sync.requestAlignment(instanceId);
    else if (this.ports.syncToInstance) {
      const task = this.alignOne(instanceId).then(result => { this.lastWriteBack = result; })
        .catch(error => { this.lastWriteBack = { written: 0, unchanged: 0, skippedOutOfScope: 0,
          failures: [error instanceof Error ? error.message : '对齐未完成。'] }; })
        .finally(() => this.background.delete(task));
      this.background.add(task);
    }
    return this.get(instanceId);
  }
  /** The local folders this instance's mapped buckets live in, for the instance to register. */
  workspaceFolders(instanceId: string): Promise<{ readonly schemaVersion: 1; readonly instanceId: string;
    readonly folders: readonly { readonly name: string; readonly path: string }[] }> {
    return this.ports.readWorkspaceFolders(instanceId).then(folders => ({ schemaVersion: 1 as const, instanceId, folders }));
  }
  /**
   * Engine start: make every registered instance's saved range true in that instance.
   *
   * The operator's rule is that the Engine's start is the moment the true source is authoritative,
   * and a saved range is a standing instruction rather than a one-off action — so a range saved
   * before this start has to reach the instance without anyone opening the board. Each instance is
   * aligned with exactly the same scoped write-back a save uses, one at a time, and one instance's
   * failure never stops another: the result is reported per instance, never thrown.
   */
  async alignRegisteredInstances(): Promise<readonly { readonly instanceId: string; readonly summary: InstanceWriteBackSummary }[]> {
    if (this.ports.syncToInstance === undefined || this.ports.registeredInstances === undefined) return [];
    const instances = [...new Set(await this.ports.registeredInstances())];
    const aligned: { instanceId: string; summary: InstanceWriteBackSummary }[] = [];
    for (const instanceId of instances) {
      try {
        const summary = await this.alignOne(instanceId);
        this.lastWriteBack = summary;
        aligned.push({ instanceId, summary });
      } catch (error) {
        aligned.push({ instanceId, summary: { written: 0, unchanged: 0, skippedOutOfScope: 0,
          failures: [error instanceof Error ? error.message : "引擎启动时无法把所选工作区写入实例。"] } });
      }
    }
    return aligned;
  }
  async effectiveScope(instanceId: string, profileId: string): Promise<InstanceWorkspaceEffectiveScope> {
    instanceWorkspaceEffectiveScopeSchema.shape.profileId.parse(profileId);
    await this.requireInstance(instanceId);
    const value = instanceWorkspaceEffectiveScopeSchema.parse(await this.ports.readEffectiveScope(instanceId, profileId));
    if (value.instanceId !== instanceId || value.profileId !== profileId)
      throw new IntegrationError("INSTANCE_WORKSPACE_SCOPE_MISMATCH", "有效范围与请求的实例配置不一致。", 502);
    return value;
  }
  async sessionAvailability(instanceId: string, logicalSessionId: string, profileId: string): Promise<InstanceSessionAvailability> {
    instanceSessionAvailabilitySchema.shape.profileId.parse(profileId);
    instanceSessionAvailabilitySchema.shape.logicalSessionId.parse(logicalSessionId);
    await this.requireInstance(instanceId);
    const value = instanceSessionAvailabilitySchema.parse(await this.ports.readSessionAvailability(instanceId, logicalSessionId, profileId));
    if (value.instanceId !== instanceId || value.profileId !== profileId || value.logicalSessionId !== logicalSessionId)
      throw new IntegrationError("INSTANCE_WORKSPACE_SCOPE_MISMATCH", "会话可用状态与请求的实例或会话不一致。", 502);
    return value;
  }
}
