import type { ExternalLifecyclePrepareRequest } from "@linmu/dsh-session-contracts";
import { IntegrationError, readIntegrationBindings } from "./bindings.js";
import { discoverLauncherIntegrations } from "./launcher-discovery.js";

export async function resolveRuntimeIntegration(stateRoot: string, request: ExternalLifecyclePrepareRequest) {
  const bindings = (await readIntegrationBindings(stateRoot)).filter(item => item.kind === "dsh" && item.instanceId === request.instanceId && item.profileId === request.profileId);
  if (bindings.length === 0) return undefined;
  if (bindings.length !== 1 || bindings[0]!.launcherDataRoot === null) throw new IntegrationError("INTEGRATION_ID_AMBIGUOUS", "启动实例存在重复接入标识，请修复接入。");
  const binding = bindings[0]!;
  const target = (await discoverLauncherIntegrations(binding.launcherDataRoot!)).targets.find(item => item.target.id === binding.targetId);
  if (target === undefined || target.target.status === "unsupported" || !target.pluginReady || target.target.version !== request.runtimeVersion || target.fingerprint !== binding.fingerprint) {
    throw new IntegrationError("INTEGRATION_RECHECK_REQUIRED", "实例或插件已改变，请在 Maintenance 设置中修复接入后再启动。");
  }
  return { adapterId: binding.adapterId, packageVersions: target.packageVersions };
}
