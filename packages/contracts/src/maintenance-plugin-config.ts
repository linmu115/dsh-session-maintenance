/**
 * The `session-maintenance` row of a profile patch, judged by the plugin's own rule.
 *
 * This row is how a machine declares its Maintenance identity, so it *must* carry a config —
 * without it the plugin publishes no handshake at all. Refusing every config on an infrastructure
 * id would therefore make the documented declaration impossible, which is the defect this module
 * closes: the config is verified instead of rejected.
 *
 * Scope is deliberately narrow, and the rule is deliberately not re-invented here:
 *
 *   * only this plugin's own row is judged; every other infrastructure id keeps being reported as
 *     a component replacement by the caller;
 *   * the accepted field set and value shapes are the plugin's own schema, mirrored in
 *     `maintenancePluginConfigIssue` below with a drift test against
 *     `plugins/dsh-session-maintenance/src/config.ts` (see that package's test suite). Changing one
 *     without the other must fail that test.
 *
 * Shared through `@linmu/dsh-session-contracts` because both the host adapter (this check) and the
 * plugin (its own `normalizeConfig`) need it, and two hand-maintained copies would drift.
 */

/** The loader row that declares this plugin, and therefore this machine's identity. */
export const MAINTENANCE_PLUGIN_ROW_ID = "session-maintenance";

/** Keys the plugin's own schema accepts on that row. Mirrors `Config` in the plugin. */
export const MAINTENANCE_PLUGIN_CONFIG_KEYS = [
  "connectionId", "dshInstanceId", "profileId", "sessionSource", "maintenanceEndpoint",
  "adapterSelection", "pinnedAdapterId", "extensionPlugins",
] as const;

const SAFE_ID = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]{0,255}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** A loopback origin without credentials or a path, exactly as the plugin's `loopbackOrigin` demands. */
function loopbackOrigin(value: string): boolean {
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
      && !endpoint.username && !endpoint.password && endpoint.pathname === "/" && !endpoint.search && !endpoint.hash;
  } catch { return false; }
}

function extensionPluginsIssue(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "extensionPlugins 必须是插件条目数组。";
  for (const [index, entry] of value.entries()) {
    if (!record(entry)) return `extensionPlugins[${index}] 必须是对象。`;
    for (const field of ["namespace", "pluginVersion", "writerId"] as const) {
      if (!nonEmptyString(entry[field])) return `extensionPlugins[${index}].${field} 必须是非空字符串。`;
    }
  }
  return undefined;
}

/**
 * Judge the config of the `session-maintenance` row.
 *
 * Returns the operator-facing reason it cannot be accepted, or `undefined` when it is exactly what
 * the plugin would accept. `fields` are the row's keys beyond `id`/`name`/`disabled`; passing them
 * in lets the caller name a field that does not belong to the plugin config at all (a loader-level
 * key such as `group`), instead of silently ignoring it.
 */
export function maintenancePluginConfigIssue(config: unknown, fields: readonly string[]): string | undefined {
  const allowed = new Set<string>(MAINTENANCE_PLUGIN_CONFIG_KEYS);
  // `id`, `name` and `disabled` are loader keys rather than plugin config; the caller has already
  // handled `disabled` (it has its own message) and `name` (a rename is not a config change).
  const foreign = fields.filter(field => !["id", "name", "disabled", "config"].includes(field) && !allowed.has(field));
  if (foreign.length > 0) return `session-maintenance 行包含不受支持的字段：${foreign.join("、")}。`;
  if (config === undefined) {
    // A row that only disables or renames the plugin needs no config; the caller handles disabled.
    return undefined;
  }
  if (!record(config)) return "session-maintenance 的 config 必须是对象。";
  const unknown = Object.keys(config).filter(key => !allowed.has(key));
  if (unknown.length > 0) return `session-maintenance 的 config 包含未知字段：${unknown.join("、")}。`;

  for (const key of ["connectionId", "dshInstanceId", "profileId"] as const) {
    const value = config[key];
    if (value === undefined) continue;
    if (!nonEmptyString(value)) return `session-maintenance 的 config.${key} 必须是非空字符串。`;
  }
  if (config["connectionId"] !== undefined && !SAFE_ID.test(String(config["connectionId"])))
    return "session-maintenance 的 config.connectionId 必须是已登记 ID，不能是路径。";
  if (config["sessionSource"] !== undefined && !["native", "maintenance"].includes(String(config["sessionSource"])))
    return "session-maintenance 的 config.sessionSource 只能是 native 或 maintenance。";
  if (config["adapterSelection"] !== undefined && !["auto", "pinned", "experimental"].includes(String(config["adapterSelection"])))
    return "session-maintenance 的 config.adapterSelection 只能是 auto、pinned 或 experimental。";
  if (config["pinnedAdapterId"] !== undefined && config["pinnedAdapterId"] !== null && !SAFE_ID.test(String(config["pinnedAdapterId"])))
    return "session-maintenance 的 config.pinnedAdapterId 必须是已登记 ID 或 null。";
  if (config["adapterSelection"] === "pinned" && (config["pinnedAdapterId"] === undefined || config["pinnedAdapterId"] === null))
    return "session-maintenance 的 config.adapterSelection=pinned 需要同时给出 pinnedAdapterId。";
  const endpoint = config["maintenanceEndpoint"];
  if (endpoint !== undefined && endpoint !== "auto" && !(typeof endpoint === "string" && loopbackOrigin(endpoint)))
    return "session-maintenance 的 config.maintenanceEndpoint 只能是 auto 或 loopback HTTP origin。";
  if (config["extensionPlugins"] !== undefined) {
    const issue = extensionPluginsIssue(config["extensionPlugins"]);
    if (issue !== undefined) return `session-maintenance 的 config.${issue}`;
  }
  return undefined;
}
