import { join } from "node:path";
import {
  CODEX_NATIVE_SYNC_UNAVAILABLE, workspaceSyncPolicySchema, workspaceSyncUpdateSchema,
  type CanonicalWorkspaceDirectory, type MaintenanceWriteScope, type WorkspaceSyncConfiguration, type WorkspaceSyncPolicy, type WorkspaceSyncUpdate,
} from "@linmu/dsh-session-contracts";
import { IntegrationError, readJsonIfPresent, writeJsonAtomically } from "./bindings.js";

export class WorkspaceSyncPolicyService {
  constructor(private readonly options: { stateRoot: string; writes: MaintenanceWriteScope; directory: () => CanonicalWorkspaceDirectory | Promise<CanonicalWorkspaceDirectory> }) {}
  private async readPolicy(): Promise<WorkspaceSyncPolicy> {
    const value = await readJsonIfPresent(join(this.options.stateRoot, "workspace-sync-policy.json"));
    if (value === undefined) return { revision: 0, workspaceIds: [], includeFutureSessions: true, nativeWriteEnabled: false };
    const parsed = workspaceSyncPolicySchema.safeParse(value);
    if (!parsed.success) throw new IntegrationError("SYNC_POLICY_INVALID", "同步范围配置无法读取，请从已验证备份恢复。", 503);
    return parsed.data;
  }
  async get(): Promise<WorkspaceSyncConfiguration> {
    const [policy, directory] = await Promise.all([this.readPolicy(), this.options.directory()]);
    return { policy, nativeSyncSupported: false, nativeSyncReason: CODEX_NATIVE_SYNC_UNAVAILABLE,
      workspaces: directory.workspaces.filter(group => group.workspace.deletedAt === null).map(group => ({
        id: group.workspace.id, name: group.workspace.name, roots: [], sessionCount: group.sessions.length, eligible: true,
        reason: "名单自动包含未来新建会话；原生归属与写入能力验证完成后才会启用回写。",
      })),
    };
  }
  async save(input: WorkspaceSyncUpdate): Promise<WorkspaceSyncConfiguration> {
    const update = workspaceSyncUpdateSchema.parse(input);
    await this.options.writes.run("workspace-sync-policy", async () => {
      const { policy, workspaces } = await this.get();
      if (policy.revision !== update.revision) throw new IntegrationError("SYNC_POLICY_CHANGED", "同步范围已在别处更新，请刷新后重新选择。");
      const allowed = new Set(workspaces.filter(item => item.eligible).map(item => item.id));
      if (update.workspaceIds.some(id => !allowed.has(id))) throw new IntegrationError("SYNC_WORKSPACE_UNKNOWN", "名单包含已移除或未识别的工作区，请刷新后重试。");
      await writeJsonAtomically(join(this.options.stateRoot, "workspace-sync-policy.json"), {
        revision: policy.revision + 1, workspaceIds: [...new Set(update.workspaceIds)].sort(), includeFutureSessions: true, nativeWriteEnabled: false,
      });
    });
    return this.get();
  }
}
