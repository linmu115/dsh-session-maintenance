import { AdapterCatalog } from '../adapter-catalog.js';
import { join } from 'node:path';
import { standaloneInstanceSchema, type StandaloneInstance } from '@linmu/dsh-session-contracts';
import { IntegrationError, readJsonIfPresent, writeJsonAtomically } from './bindings.js';
import { inspectStandaloneInstance, type DiscoveredIntegration } from './launcher-discovery.js';

export async function readStandaloneInstances(root: string): Promise<StandaloneInstance[]> {
  const configs = standaloneInstanceSchema.array().parse(await readJsonIfPresent(join(root, 'standalone-instances.json')) ?? []);
  const keys = configs.map(item => JSON.stringify([item.instanceId, item.profileId]));
  if (new Set(keys).size !== keys.length) throw new IntegrationError('INSTANCE_ID_AMBIGUOUS', '独立实例标识重复，请修复配置。');
  return configs;
}
export async function saveStandaloneInstance(root: string, config: StandaloneInstance): Promise<DiscoveredIntegration> {
  const input = standaloneInstanceSchema.parse(config), checked = await inspectConfiguredInstance(root, input);
  if (!checked.pluginReady && checked.pluginIssue) throw new IntegrationError(checked.pluginIssue.code, checked.pluginIssue.message);
  if (checked.target.status === 'unsupported' || !checked.pluginReady) throw new IntegrationError('INSTANCE_NOT_READY', [...checked.target.issues, ...(!checked.pluginReady ? ['请先安装并启用实例接入插件。'] : [])].join(' '));
  const configs = await readStandaloneInstances(root);
  await writeJsonAtomically(join(root, 'standalone-instances.json'), [...configs.filter(item => item.instanceId !== input.instanceId || item.profileId !== input.profileId), input]);
  return checked;
}
export async function discoverStandaloneInstances(root: string): Promise<DiscoveredIntegration[]> {
  const rows: DiscoveredIntegration[] = [];
  for (const config of await readStandaloneInstances(root)) {
    // Invalid registered targets remain visible through the binding directory.
    try { rows.push(await inspectConfiguredInstance(root, config)); } catch { /* Do not load an unverified runtime. */ }
  }
  return rows;
}

/** An explicit custom adapter is never silently replaced by a bundled implementation. */
export async function inspectConfiguredInstance(root: string, config: StandaloneInstance): Promise<DiscoveredIntegration> {
  if (!config.adapterId) return inspectStandaloneInstance(config);
  const catalog = await new AdapterCatalog(root).load();
  const selected = catalog.instances.find(item => item.entry.id === config.adapterId);
  if (!selected?.adapter.hostIntegration) throw new IntegrationError('HOST_ADAPTER_UNAVAILABLE', '所选实例 adapter 未启用，或未提供 hostIntegration.inspect。');
  const target = await selected.adapter.hostIntegration.inspect(config);
  if (target.instanceId !== config.instanceId || target.target.profile !== config.profileId || target.target.version !== config.runtimeVersion || target.target.adapterId !== selected.entry.id || target.launcherDataRoot !== null)
    throw new IntegrationError('HOST_ADAPTER_IDENTITY_MISMATCH', 'Adapter 检查结果与所选独立实例不一致。');
  return target;
}
