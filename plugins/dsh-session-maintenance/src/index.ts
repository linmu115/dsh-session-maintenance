import { bindRc2ProjectionContext } from './rc2-persistence.js';
import { MaintenanceSessionContext,registerSessionContext } from './session-context.js';
import { installRc2LazyProjectionPersistence } from './rc2-lazy-persistence.js';
import type { Context } from "@deepseek-ai/cordis";
import { MaintenanceExtensionBridge, registerMaintenanceExtensionData } from "./extension-data.js";
import s from "@deepseek-ai/schemastery";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { JsonValue } from "@linmu/dsh-session-contracts";

import { connectionDescriptorPath, launcherProjectionProfile, launcherCoreBinding, normalizeConfig, type Config as PluginConfig } from "./config.js";
import { createCoreGatewayHandler, type CoreRuntimeContext } from "./core-gateway.js";
import { launchDashboard } from "./dashboard-launcher.js";
import { createProxyHandler, FileConnectionProvider, RestrictedEngineProxy } from "./engine-proxy.js";
import { registerManagerActions, type ManagerActionContext } from "./manager-actions.js";
import {
  SessionPersistenceProjection,
  HttpProjectionRuntimeTransport,
  ProjectionRuntimeRegistrar,
  RuntimeBrokerPluginClient,
} from "./projection-runtime.js";
import { createRuntimeShutdownHandler } from "./runtime-shutdown.js";
import { type LazyHydrationStage } from "./lazy-persistence.js";

export const name = "dsh-session-maintenance";
export type Config = PluginConfig;

export const Config: s = s.object({
  connectionId: s.string().default("primary"),
  dshInstanceId: s.string().default("dsh-web"),
  profileId: s.string().default("web"),
  sessionSource: s.string().default("native"),
  maintenanceEndpoint: s.string().default("auto"),
  adapterSelection: s.string().default("auto"),
  pinnedAdapterId: s.string().default(""),
  extensionPlugins: s.array(s.object({ namespace:s.string(),pluginVersion:s.string(),writerId:s.string() })),
});

export const inject = ["webServer", "appExit", "sessions", "sessionPersistence", "workspaceRegistry", "sessionProjectionCache", "sessionQuery", "storageDomain"] as const;

interface HostContext extends CoreRuntimeContext {
  readonly appExit: (code: number) => void;
  readonly sessions: CoreRuntimeContext["sessions"] & { flush(session: Session): Promise<boolean> };
  readonly webServer: { register(input: { kind: "prefix"; path: string; handler: ReturnType<typeof createProxyHandler> | ReturnType<typeof createCoreGatewayHandler> }): void | (() => void) };
  readonly logger?: { info(message: string): void; warn(message: string): void };
  effect(callback: () => void | (() => void | Promise<void>), label?: string): void;
  on(event: "session/event", listener: (session: Session, event: SessionEvent) => void): () => void;
  on(event: "session/flush", listener: (session: Session) => Promise<void> | void): () => void;
  inject?(services: readonly string[], callback: (ctx: HostContext & ManagerActionContext) => void): void;
}

export async function apply(ctx: HostContext, input: PluginConfig): Promise<void> {
  const config = normalizeConfig({ ...input, pinnedAdapterId: input.pinnedAdapterId || null });
  const launchProfile = launcherProjectionProfile(config);
  const coreBinding = launcherCoreBinding(config, launchProfile);
  const descriptorPath = connectionDescriptorPath(config.connectionId);
  const connection = descriptorPath === undefined
    ? { current: async () => { throw new Error("维护引擎连接尚未由可信安装器登记"); } }
    : new FileConnectionProvider(descriptorPath);
  const proxy = new RestrictedEngineProxy(config, connection, fetch, launchProfile?.runId);
  (ctx as unknown as Context).provide("maintenanceReferenceResolver", {
    resolve: (location: import("./engine-proxy.js").ProxyRequest) => proxy.invoke({ ...location, operation: "reference:resolve" }),
  });
  if (launchProfile !== null) {
    const transport = new HttpProjectionRuntimeTransport(fetch, async () => {
      const current = await connection.current();
      if (current.origin !== launchProfile.maintenanceEndpoint) throw new Error("Launcher Runtime Broker endpoint differs from the trusted Engine descriptor");
      return `Bearer ${current.token}`;
    });
    const projectionBinding = await bindRc2ProjectionContext(ctx as unknown as Context);
    ctx.effect(() => () => projectionBinding.dispose(), "dsh-session-maintenance: projection domain");
    const overlay = new SessionPersistenceProjection(
      projectionBinding.context,
      launchProfile.temporaryPersistenceRootId,
      (stage, detail) => {
        const fields = Object.entries(detail).map(([key, value]) => `${key}=${String(value)}`).join(" ");
        const message = `[dsh-session-maintenance] ${stage}${fields.length === 0 ? "" : ` ${fields}`}`;
        if (ctx.logger === undefined) console.info(message);
        else ctx.logger.info(message);
      },
    );
    const registrar = new ProjectionRuntimeRegistrar({ transport, overlay,
      ...(launchProfile.nativeMode ? { nativeMode: launchProfile.nativeMode } : {}) });
    const runtime = new RuntimeBrokerPluginClient({
      connection,
      registrar,
      clientId: launchProfile.runtimeClientId,
      runId: launchProfile.runId,
      temporaryPersistenceRootId: launchProfile.temporaryPersistenceRootId,
      maintenanceEndpoint: launchProfile.maintenanceEndpoint,
      ...(launchProfile.nativeMode ? { nativeMode: launchProfile.nativeMode } : {}),
    });
    try { await runtime.attach(); }
    catch (error) { throw new Error("RC2 prepared runtime could not attach", { cause: error }); }
    if (config.extensionPlugins !== undefined) {
      const extensions = new MaintenanceExtensionBridge(connection,{instanceId:config.dshInstanceId,profileId:config.profileId},config.extensionPlugins);
      try {
        await extensions.connect();
        await registerMaintenanceExtensionData(ctx as unknown as Context,extensions);
        if(config.extensionPlugins.some(p=>p.namespace==="annotation-upstream")) {
          registerSessionContext(ctx as unknown as Context,new MaintenanceSessionContext(connection,launchProfile.runId,id=>runtime.flush(id)));
        }
      } catch {
        // Optional extension initialization must never skip native event/drain hooks.
        const message = "[dsh-session-maintenance] 扩展数据暂未接通；保留本地未提交编辑，重新连接后再保存。";
        if (ctx.logger) ctx.logger.warn(message); else console.warn(message);
      }
    }
    const lazyStatus = (stage: LazyHydrationStage, sessionId?: string, error?: unknown) => {
      const suffix = sessionId === undefined ? "" : ` session=${sessionId}`;
      const message = `[dsh-session-maintenance] ${stage}${suffix}`;
      if (stage === "lazy.materialize.failed") {
        const failure = `${message} error=${error instanceof Error ? error.message : String(error)}`;
        if (ctx.logger === undefined) console.warn(failure);
        else ctx.logger.warn(failure);
      } else if (ctx.logger === undefined) {
        console.info(message);
      } else {
        ctx.logger.info(message);
      }
    };
    const restorePersistence = launchProfile.nativeMode ? () => undefined : installRc2LazyProjectionPersistence(
      (ctx as unknown as Context).sessionPersistence,
      runtime,
      lazyStatus,
    );
    const observedSessions = new Map<string, Session>();
    const offEvent = ctx.on("session/event", (session, event) => {
      observedSessions.set(String(session.id), session);
      runtime.observe(
        String(session.id),
        event as unknown as JsonValue,
        session.header as unknown as JsonValue,
        (fromOffset, toOffsetExclusive) => session.snapshotEvents(
          fromOffset as never,
          toOffsetExclusive as never,
        ) as unknown as readonly JsonValue[],
        { inheritedEventCount: Number(session.inheritedEventCount) },
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
    const unregisterShutdown = ctx.webServer.register({
      kind: "prefix",
      path: "/dsh-session-maintenance/runtime/shutdown",
      handler: createRuntimeShutdownHandler({
        connection,
        runId: launchProfile.runId,
        ownerClientId: launchProfile.ownerClientId,
        exit: (code) => { ctx.appExit(code); },
      }),
    });
    ctx.effect(() => () => {
      restorePersistence();
      if (typeof unregisterShutdown === "function") unregisterShutdown();
    }, "dsh-session-maintenance: graceful runtime shutdown");
  }
  const unregisterProxy = ctx.webServer.register({
    kind: "prefix",
    path: "/dsh-session-maintenance/api",
    handler: createProxyHandler(proxy),
  });
  const coreHandler = createCoreGatewayHandler({ runtime: ctx, connection, ...(coreBinding === undefined ? {} : { binding: coreBinding }) });
  const unregisterCore = ctx.webServer.register({
    kind: "prefix",
    path: "/dsh-session-maintenance/core",
    handler: coreHandler,
  });
  ctx.effect(() => async () => {
    if (typeof unregisterCore === "function") unregisterCore();
    if (typeof unregisterProxy === "function") unregisterProxy();
    await coreHandler.dispose();
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
export * from "./runtime-shutdown.js";
export * from "./lazy-persistence.js";


declare module "@deepseek-ai/cordis" {
  interface Context {
    maintenanceReferenceResolver: { resolve(location: import("./engine-proxy.js").ProxyRequest): Promise<import("./engine-proxy.js").ProxyResult> };
  }
}
