import type { MaintenanceWriteScope, IntegrationAction, IntegrationDirectory, IntegrationTarget } from "@linmu/dsh-session-contracts";
import { CODEX_NATIVE_SYNC_UNAVAILABLE } from "@linmu/dsh-session-contracts";
import { IntegrationError, readIntegrationBindings, saveIntegrationBindings } from "./bindings.js";
import type { DiscoveredIntegration, DiscoveredIntegrations } from "./launcher-discovery.js";
import { configureLauncherHook, desiredLauncherHook, launcherHookPath, launcherHooksEqual, installIntegrationPlugin, type IntegrationInstallOptions } from "./launcher-install.js";
import { readJsonIfPresent, writeJsonAtomically } from "./bindings.js";
import { unlink } from "node:fs/promises";

export interface IntegrationServiceOptions {
  readonly stateRoot: string;
  readonly writes: MaintenanceWriteScope;
  readonly discover: () => Promise<DiscoveredIntegrations>;
  readonly installation: IntegrationInstallOptions;
  readonly verifyAdapter: (target: DiscoveredIntegration) => Promise<void>;
  /** Runs within the same writer scope, before a successful binding can be published. */
  readonly registerSource?: (target: DiscoveredIntegration) => Promise<void>;
  readonly clock?: () => string;
}

/** Coordinates onboarding while keeping slow package installs outside the canonical writer queue. */
export class InstanceIntegrationService {
  private readonly installing = new Set<string>();
  private readonly generations = new Map<string, number>();
  constructor(private readonly options: IntegrationServiceOptions) {}

  async list(): Promise<IntegrationDirectory> {
    const [discovery, bindings] = await Promise.all([this.options.discover(), readIntegrationBindings(this.options.stateRoot)]);
    const targets = await Promise.all(discovery.targets.map(async item => {
      const target: IntegrationTarget = { ...item.target, capabilities: item.target.capabilities.map(capability => ({ ...capability })), issues: [...item.target.issues] };
      const binding = bindings.find(bound => bound.targetId === target.id);
      if (binding !== undefined) {
        let hookReady = target.kind === "codex" && item.codexRegistered !== false;
        if (target.kind === "dsh") {
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
    if (action === "disconnect") {
      this.generations.set(targetId, (this.generations.get(targetId) ?? 0) + 1);
      await this.options.writes.run("integration-disconnect", async () => {
        const bindings = await readIntegrationBindings(this.options.stateRoot);
        await saveIntegrationBindings(this.options.stateRoot, bindings.filter(item => item.targetId !== targetId));
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
      if (before.target.kind === "dsh") {
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
        const hookPath = after.target.kind === "dsh" ? launcherHookPath(after) : null;
        const oldHook = hookPath === null ? undefined : await readJsonIfPresent(hookPath);
        let publishedHook: unknown;
        try {
          await this.options.registerSource?.(after);
          assertCurrent();
          if (hookPath !== null) { await configureLauncherHook(after, this.options.installation); publishedHook = await readJsonIfPresent(hookPath); }
          assertCurrent();
          await saveIntegrationBindings(this.options.stateRoot, [...bindings.filter(item => item.targetId !== targetId), {
            targetId, kind: after.target.kind, instanceId: after.instanceId, profileId: after.target.profile,
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
