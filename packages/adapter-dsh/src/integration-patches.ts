function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
const infrastructure = new Set(["session", "session-maintenance", "session-persistence", "session-persistence-jsonl", "session-query-sqlite", "session-projection", "session-projection-cache", "session-controller", "workspace", "workspace-controller", "web-startup", "webserver", "web-runtime"]);
const infrastructurePackages = new Set(["dsh-session-maintenance", ...["session", "session-persistence", "session-query", "session-projection-cache", "workspace", "web-app", "web-runtime", "webserver"].map(name => `@deepseek-ai/dsh-${name}`)]);

export function maintenanceIntegrationBundleReady(patches: readonly unknown[]): boolean {
  if (patches.length !== 1 || !record(patches[0]) || !Array.isArray(patches[0].insert) || patches[0].insert.length !== 1) return false;
  const entry: unknown = patches[0].insert[0];
  return record(entry) && entry.id === "session-maintenance" && entry.name === "dsh-session-maintenance" && entry.group !== true && (entry.disabled === undefined || entry.disabled === false);
}

/** Conservative offline probe for the verified Alpha2/RC1 profile patch dialect.
 * Custom replacements of session infrastructure require a separate compatibility check.
 * Other plugin settings remain permitted; no user configuration is executed or rewritten.
 */
export function inspectDshIntegrationOverrides(layers: readonly unknown[]): string[] {
  const issues = new Set<string>();
  const inspectInsert = (entries: unknown): void => {
    if (!Array.isArray(entries)) { issues.add("配置中存在无法验证的插件插入规则。"); return; }
    for (const entry of entries) {
      if (!record(entry)) { issues.add("配置中存在无法验证的插件条目。"); continue; }
      if (typeof entry.id === "string" && infrastructure.has(entry.id) || typeof entry.name === "string" && infrastructurePackages.has(entry.name)) issues.add("用户配置替换了会话或 Web 基础组件，需要单独验证该配置。");
      if (entry.group === true) inspectInsert(entry.config);
    }
  };
  for (const layer of layers) {
    if (layer === null || layer === undefined) continue;
    if (!Array.isArray(layer)) { issues.add("用户配置不是受支持的补丁列表。"); continue; }
    for (const patch of layer) {
      if (!record(patch)) { issues.add("用户配置包含无法识别的补丁。"); continue; }
      if (patch.insert !== undefined) inspectInsert(patch.insert);
      if (typeof patch.id !== "string" || !infrastructure.has(patch.id)) continue;
      if (patch.disabled !== undefined && patch.disabled !== false) issues.add("用户配置禁用了会话或 Web 基础组件，请恢复后重新检查接入。");
      if (Object.keys(patch).some(key => !["id", "name", "disabled"].includes(key))) issues.add("用户配置修改了会话或 Web 基础组件，需要单独验证该配置。");
    }
  }
  return [...issues];
}
