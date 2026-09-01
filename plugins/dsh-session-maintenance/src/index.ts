import s from "@deepseek-ai/schemastery";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { JsonValue } from "@linmu/dsh-session-contracts";

import { connectionDescriptorPath, launcherProjectionProfile, normalizeConfig, type Config as PluginConfig } from "./config.js";
import { createCoreGatewayHandler, type CoreRuntimeContext } from "./core-gateway.js";
import { launchDashboard } from "./dashboard-launcher.js";
import { createProxyHandler, FileConnectionProvider, RestrictedEngineProxy } from "./engine-proxy.js";
import { registerManagerActions, type ManagerActionContext } from "./manager-actions.js";
import {
  Alpha2SessionPersistenceProjection,
  HttpProjectionRuntimeTransport,
  ProjectionRuntimeRegistrar,
  RuntimeBrokerPluginClient,
} from "./projection-runtime.js";

export const name = "dsh-session-maintenance";
export type Config = PluginConfig;

export const Config = s.object({
  connectionId: s.string().default("primary"),
  dshInstanceId: s.string().default("dsh-web"),
  profileId: s.string().default("web"),
  sessionSource: s.string().default("native"),
  maintenanceEndpoint: s.string().default("auto"),
  adapterSelection: s.string().default("auto"),
  pinnedAdapterId: s.string().default(""),
});

export const inject = ["webServer", "sessions", "sessionPersistence", "workspaceRegistry", "sessionProjectionCache", "sessionQuery"] as const;

interface HostContext extends CoreRuntimeContext {
  readonly sessions: CoreRuntimeContext["sessions"] & { flush(session: Session): Promise<void> };
  readonly webServer: { register(input: { kind: "prefix"; path: string; handler: ReturnType<typeof createProxyHandler> | ReturnType<typeof createCoreGatewayHandler> }): void | (() => void) };
  effect(callback: () => void | (() => void | Promise<void>), label?: string): void;
  on(event: "session/event", listener: (session: Session, event: SessionEvent) => void): () => void;
  on(event: "session/flush", listener: (session: Session) => Promise<void> | void): () => void;
  inject?(services: readonly string[], callback: (ctx: HostContext & ManagerActionContext) => void): void;
}

export async function apply(ctx: HostContext, input: PluginConfig): Promise<void> {
  const config = normalizeConfig({ ...input, pinnedAdapterId: input.pinnedAdapterId || null });
  const launchProfile = launcherProjectionProfile(config);
  const descriptorPath = connectionDescriptorPath(config.connectionId);
  const connection = descriptorPath === undefined
    ? { current: async () => { throw new Error("维护引擎连接尚未由可信安装器登记"); } }
    : new FileConnectionProvider(descriptorPath);
  const proxy = new RestrictedEngineProxy(config, connection);
  if (launchProfile !== null) {
    const transport = new HttpProjectionRuntimeTransport(fetch, async () => {
      const current = await connection.current();
      if (current.origin !== launchProfile.maintenanceEndpoint) throw new Error("Launcher Runtime Broker endpoint differs from the trusted Engine descriptor");
      return `Bearer ${current.token}`;
    });
    const overlay = new Alpha2SessionPersistenceProjection(ctx as never, launchProfile.temporaryPersistenceRootId);
    const registrar = new ProjectionRuntimeRegistrar({ transport, overlay });
    const runtime = new RuntimeBrokerPluginClient({
      connection,
      registrar,
      clientId: launchProfile.runtimeClientId,
      runId: launchProfile.runId,
      temporaryPersistenceRootId: launchProfile.temporaryPersistenceRootId,
      maintenanceEndpoint: launchProfile.maintenanceEndpoint,
    });
    await runtime.attach();
    const observedSessions = new Map<string, Session>();
    const offEvent = ctx.on("session/event", (session, event) => {
      observedSessions.set(String(session.id), session);
      runtime.observe(
        String(session.id),
        event as unknown as JsonValue,
        session.header as unknown as JsonValue,
        session.events as unknown as readonly JsonValue[],
      );
    });
    const offFlush = ctx.on("session/flush", async (session) => {
      observedSessions.set(String(session.id), session);
      await runtime.flush(String(session.id));
    });
    ctx.effect(() => async () => {
      for (const session of observedSessions.values()) await ctx.sessions.flush(session);
      offEvent();
      offFlush();
      await runtime.drain(new Date().toISOString());
    }, "dsh-session-maintenance: runtime broker session durability");
  }
  const unregisterProxy = ctx.webServer.register({
    kind: "prefix",
    path: "/dsh-session-maintenance/api",
    handler: createProxyHandler(proxy),
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
  ctx.inject?.(["resourceManagementActions"], (actionContext) => {
    registerManagerActions(actionContext, proxy, launchDashboard);
  });
}

export * from "./config.js";
export * from "./core-gateway.js";
export * from "./engine-proxy.js";
export * from "./manager-actions.js";
export * from "./projection-runtime.js";
