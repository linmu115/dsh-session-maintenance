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
