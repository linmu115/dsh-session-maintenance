import { join } from "node:path";

export const SUPPORTED_DSH_VERSION = "0.1.1-rc.2" as const;

export interface Config {
  readonly connectionId: string;
  readonly dshInstanceId: string;
  readonly profileId: string;
}

export function normalizeConfig(config: Config): Config {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(config.connectionId)) throw new TypeError("connectionId 必须是可信安装器登记的 ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(config.dshInstanceId)) {
    throw new TypeError("dshInstanceId must be a registered ID, not a path");
  }
  return { ...config };
}

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
