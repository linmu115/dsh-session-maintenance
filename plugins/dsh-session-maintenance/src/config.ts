import { join } from "node:path";

export const SUPPORTED_DSH_VERSION = "0.1.1-rc.2" as const;

export interface Config {
  readonly connectionId: string;
  readonly dshInstanceId: string;
  readonly profileId: string;
  readonly sessionSource?: "native" | "maintenance";
  readonly maintenanceEndpoint?: "auto" | string;
  readonly adapterSelection?: "auto" | "pinned" | "experimental";
  readonly pinnedAdapterId?: string | null;
}

export interface LauncherProjectionProfile {
  readonly schemaVersion: 1;
  readonly sessionSource: "maintenance";
  readonly maintenanceEndpoint: string;
  readonly adapterSelection: "auto" | "pinned" | "experimental";
  readonly pinnedAdapterId: string | null;
  readonly branchId: string;
  readonly ownerClientId: string;
  readonly runtimeClientId: string;
  readonly runId: string;
  readonly temporaryPersistenceRootId: string;
  readonly dshVersion: string;
  readonly nativeMode?: "persistent-native-v1";
}

const SAFE_ID = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]{0,255}$/u;

function loopbackOrigin(value: string): string {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new TypeError("maintenanceEndpoint must be a loopback HTTP endpoint");
  }
  if (endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new TypeError("maintenanceEndpoint must be an origin without credentials or a session path");
  }
  return endpoint.origin;
}

export function normalizeConfig(config: Config): Config {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(config.connectionId)) throw new TypeError("connectionId 必须是可信安装器登记的 ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(config.dshInstanceId)) {
    throw new TypeError("dshInstanceId must be a registered ID, not a path");
  }
  const sessionSource = config.sessionSource ?? "native";
  const adapterSelection = config.adapterSelection ?? "auto";
  const pinnedAdapterId = config.pinnedAdapterId ?? null;
  if (sessionSource !== "native" && sessionSource !== "maintenance") throw new TypeError("sessionSource is invalid");
  if (!["auto", "pinned", "experimental"].includes(adapterSelection)) throw new TypeError("adapterSelection is invalid");
  if (adapterSelection === "pinned" && (pinnedAdapterId === null || !SAFE_ID.test(pinnedAdapterId))) {
    throw new TypeError("pinnedAdapterId is required for pinned adapter selection");
  }
  const maintenanceEndpoint = config.maintenanceEndpoint ?? "auto";
  if (maintenanceEndpoint !== "auto") loopbackOrigin(maintenanceEndpoint);
  return { ...config, sessionSource, maintenanceEndpoint, adapterSelection, pinnedAdapterId };
}

export function launcherProjectionProfile(
  config: Config,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): LauncherProjectionProfile | null {
  const normalized = normalizeConfig(config);
  const encoded = environment.DSH_SESSION_MAINTENANCE_LAUNCH_PROFILE;
  if (encoded === undefined || encoded.trim().length === 0) {
    if (normalized.sessionSource !== "maintenance") return null;
    throw new TypeError("Maintenance sessions require a Runtime Broker prepared handoff before DSH starts");
  }
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { throw new TypeError("Launcher Maintenance profile metadata is not valid JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Launcher Maintenance profile metadata is invalid");
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion", "sessionSource", "maintenanceEndpoint", "adapterSelection", "pinnedAdapterId", "branchId",
    "ownerClientId", "runtimeClientId", "runId", "temporaryPersistenceRootId", "dshVersion", "nativeMode",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new TypeError("Launcher Maintenance profile metadata contains unsupported fields");
  if (record.schemaVersion !== 1 || record.sessionSource !== "maintenance") throw new TypeError("Launcher Maintenance profile schema is unsupported");
  if (record.nativeMode !== undefined && record.nativeMode !== "persistent-native-v1") throw new TypeError("Unsupported native persistence mode");
  if (record.adapterSelection !== "auto" && record.adapterSelection !== "pinned" && record.adapterSelection !== "experimental") {
    throw new TypeError("Launcher adapterSelection is invalid");
  }
  if (record.pinnedAdapterId !== null && (typeof record.pinnedAdapterId !== "string" || !SAFE_ID.test(record.pinnedAdapterId))) {
    throw new TypeError("Launcher pinnedAdapterId is invalid");
  }
  if (record.adapterSelection === "pinned" && record.pinnedAdapterId === null) throw new TypeError("Launcher pinned adapter is missing");
  if (typeof record.branchId !== "string" || !SAFE_ID.test(record.branchId)) throw new TypeError("Launcher branchId is invalid");
  for (const key of ["ownerClientId", "runtimeClientId", "runId", "temporaryPersistenceRootId"] as const) {
    if (typeof record[key] !== "string" || !SAFE_ID.test(record[key] as string)) throw new TypeError(`Launcher ${key} is invalid`);
  }
  if (typeof record.dshVersion !== "string" || record.dshVersion.length === 0 || record.dshVersion.length > 100) {
    throw new TypeError("Launcher dshVersion is invalid");
  }
  return {
    schemaVersion: 1,
    sessionSource: "maintenance",
    maintenanceEndpoint: loopbackOrigin(String(record.maintenanceEndpoint)),
    adapterSelection: record.adapterSelection,
    pinnedAdapterId: record.pinnedAdapterId as string | null,
    branchId: record.branchId,
    ownerClientId: record.ownerClientId as string,
    runtimeClientId: record.runtimeClientId as string,
    runId: record.runId as string,
    temporaryPersistenceRootId: record.temporaryPersistenceRootId as string,
    dshVersion: record.dshVersion,
    ...(record.nativeMode ? { nativeMode: "persistent-native-v1" as const } : {}),
  };
}

export type { ProjectionRuntimeDescriptor } from "./projection-runtime.js";
export { normalizeProjectionRuntimeDescriptor } from "./projection-runtime.js";

export function connectionDescriptorPath(
  connectionId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const key = `DSH_SESSION_MAINTENANCE_CONNECTION_${connectionId.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "_")}`;
  const registered = environment[key];
  if (registered !== undefined && registered.trim().length > 0) return registered;

  // `primary` is the installer-owned, per-user Engine registration. Resolving
  // its conventional location keeps the plugin independent from launchers
  // that may filter custom environment variables when they re-spawn DSH.
  if (connectionId !== "primary") return undefined;
  const localAppData = environment.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.trim().length === 0) return undefined;
  return join(localAppData, "DSH-Session-Maintenance", "connection.json");
}
