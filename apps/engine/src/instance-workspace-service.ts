import {
  instanceWorkspaceConfigurationSchema, instanceWorkspaceEffectiveScopeSchema, instanceSessionAvailabilitySchema,
  instanceWorkspaceInstanceDirectorySchema, instanceWorkspaceInstanceIdSchema, instanceWorkspacePolicyUpdateSchema,
  type InstanceWorkspaceConfiguration, type InstanceWorkspaceEffectiveScope, type InstanceSessionAvailability,
  type InstanceWorkspaceInstanceDirectory, type InstanceWorkspacePolicyUpdate,
} from "@linmu/dsh-session-contracts";
import { IntegrationError } from "./integrations/bindings.js";

export interface InstanceWorkspacePorts {
  listInstances(): Promise<InstanceWorkspaceInstanceDirectory>;
  readConfiguration(instanceId: string): Promise<InstanceWorkspaceConfiguration>;
  writePolicy(instanceId: string, update: InstanceWorkspacePolicyUpdate): Promise<unknown>;
  readEffectiveScope(instanceId: string, profileId: string): Promise<InstanceWorkspaceEffectiveScope>;
  readSessionAvailability(instanceId: string, logicalSessionId: string, profileId: string): Promise<InstanceSessionAvailability>;
}
/** Transport boundary only. The provider owns policy writes and active run snapshots. */
export class InstanceWorkspaceService {
  constructor(private readonly ports: InstanceWorkspacePorts) {}
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
    return { ...value, pendingActivation: value.activeScopes.some(scope => scope.policyRevision !== value.policy.revision) };
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
    return this.get(instanceId);
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
