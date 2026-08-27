import s from "@deepseek-ai/schemastery";

import { normalizeConfig, type Config as PluginConfig } from "./config.js";
import { createCoreGatewayHandler, type CoreRuntimeContext } from "./core-gateway.js";
import { createProxyHandler, FileConnectionProvider, RestrictedEngineProxy } from "./engine-proxy.js";

export const name = "dsh-session-maintenance";
export type Config = PluginConfig;

export const Config = s.object({
  connectionId: s.string().default("primary"),
  dshInstanceId: s.string().default("dsh-web"),
  profileId: s.string().default("web"),
});

export const inject = ["webServer", "sessions", "sessionPersistence", "workspaceRegistry", "sessionProjectionCache", "sessionQuery"] as const;

interface HostContext extends CoreRuntimeContext {
  readonly webServer: { register(input: { kind: "prefix"; path: string; handler: ReturnType<typeof createProxyHandler> | ReturnType<typeof createCoreGatewayHandler> }): void | (() => void) };
  effect(callback: () => void | (() => void), label?: string): void;
}

export function apply(ctx: HostContext, input: PluginConfig): void {
  const config = normalizeConfig(input);
  const key = `DSH_SESSION_MAINTENANCE_CONNECTION_${config.connectionId.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "_")}`;
  const descriptorPath = process.env[key];
  const connection = descriptorPath === undefined
    ? { current: async () => { throw new Error("维护引擎连接尚未由可信安装器登记"); } }
    : new FileConnectionProvider(descriptorPath);
  const unregisterProxy = ctx.webServer.register({
    kind: "prefix",
    path: "/dsh-session-maintenance/api",
    handler: createProxyHandler(new RestrictedEngineProxy(config, connection)),
  });
  const unregisterCore = ctx.webServer.register({
    kind: "prefix",
    path: "/dsh-session-maintenance/core",
    handler: createCoreGatewayHandler({ runtime: ctx, connection }),
  });
  ctx.effect(() => () => {
    if (typeof unregisterCore === "function") unregisterCore();
    if (typeof unregisterProxy === "function") unregisterProxy();
  }, "dsh-session-maintenance: host gateways");
}

export * from "./config.js";
export * from "./core-gateway.js";
export * from "./engine-proxy.js";
