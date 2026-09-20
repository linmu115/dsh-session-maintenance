import { hostPluginDeclarationSchema, type HostPluginIssue } from '@linmu/dsh-session-contracts';

// Frozen compatibility for packages released before declarations existed. Never extend
// this list for a new release: new packages must declare their integration contract.
const legacyRc2 = new Set(['0.2.25-rc2.2', ...Array.from({ length: 35 }, (_, i) => `0.2.26-rc2.${i + 1}`)]);
const legacyEarlier = new Set(['0.2.19', '0.2.20', '0.2.24', '0.2.25-rc2.1', ...legacyRc2]);
const required = ['canonical-session-projection', 'managed-write-access', 'durable-close'];
const issue = (code: string, message: string): HostPluginIssue => ({ code, message });

/** DSH-specific compatibility belongs to this adapter, not Engine orchestration. */
export function checkDshPluginDeclaration(manifest: { version: string; dshMaintenanceIntegration?: unknown }, hostVersion: string): HostPluginIssue | null {
  const declaration = manifest.dshMaintenanceIntegration;
  if (declaration === undefined) {
    const allowed = hostVersion === '0.1.5-rc.2' ? legacyRc2
      : ['0.1.2-alpha.2', '0.1.2-rc.1'].includes(hostVersion) ? legacyEarlier : new Set<string>();
    return allowed.has(manifest.version) ? null : issue('INSTANCE_PLUGIN_DECLARATION_MISSING', `已安装接入插件 ${manifest.version}，但没有兼容声明，也不属于已验证的旧版本；请安装匹配的实例 adapter。`);
  }
  const parsed = hostPluginDeclarationSchema.safeParse(declaration);
  if (!parsed.success) return issue('INSTANCE_PLUGIN_DECLARATION_INVALID', '接入插件兼容声明格式无效，请重新安装完整发行包。');
  const value = parsed.data;
  if (value.protocol.id !== 'maintenance-dsh-integration' || value.protocol.version !== 1)
    return issue('INSTANCE_PLUGIN_PROTOCOL_UNSUPPORTED', `接入插件协议 ${value.protocol.id}/${value.protocol.version} 不受此 adapter 支持。`);
  if (value.adapterId !== 'dsh-0.1.5' || hostVersion !== '0.1.5-rc.2' || !value.hostVersions.includes(hostVersion))
    return issue('INSTANCE_PLUGIN_HOST_UNSUPPORTED', `接入插件 ${manifest.version} 不支持当前宿主 ${hostVersion} 或 adapter 身份不匹配。`);
  if (!value.sessionFormats.includes('dsh-0.1.5-v3-jsonl-zstd-v1'))
    return issue('INSTANCE_PLUGIN_FORMAT_UNSUPPORTED', '接入插件未声明支持当前 DSH 会话格式。');
  const missing = required.filter(capability => !value.capabilities.includes(capability));
  return missing.length ? issue('INSTANCE_PLUGIN_CAPABILITY_MISSING', `接入插件缺少必要能力声明：${missing.join(', ')}。`) : null;
}
