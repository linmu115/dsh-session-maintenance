import { retryExtensionConnect } from './retry-extension-connect.js';
import { GraphDataAdapter } from './graph-data-adapter.js';
import { registerMaintenanceBusinessPages } from "./business-pages.js";
import { registerMaintenanceInstanceWorkspace } from "./instance-workspace.js";
import { bindRc2ProjectionContext, rc2RuntimeHeader } from './rc2-persistence.js';
import { MaintenanceSessionContext,registerSessionContext } from './session-context.js';
import { MaintenanceGraph, registerMaintenanceGraph } from './session-graph.js';
import { MaintenanceNativeContext, registerMaintenanceNativeContext, nativeContextReady } from './native-context.js';
import { MaintenanceKnowledge, registerMaintenanceKnowledge } from './session-knowledge.js';
import { registerWorkspaceArchiveBridge } from './workspace-archive-bridge.js';
import { registerAnnotationMirror, type AnnotationMirrorContext } from './annotation-mirror.js';
import { installRc2LazyProjectionPersistence } from './rc2-lazy-persistence.js';
import { RegisteredSessionWriteAccess } from './write-access.js';
import { FrozenWriteScope, ScopedSessionWriteAccess, openWriteScope, writeTargetOf, type WriteScopePort } from './write-access-scope.js';
import { assertRegisteredStartup } from './registered-startup.js';
import type { Context } from "@deepseek-ai/cordis";
import { MaintenanceExtensionBridge, registerMaintenanceExtensionData } from "./extension-data.js";
import s from "@deepseek-ai/schemastery";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { JsonValue } from "@linmu/dsh-session-contracts";

import { connectionDescriptorPath, launcherProjectionProfile, launcherCoreBinding, maintenanceStateRoot, normalizeConfig, withLauncherNativeExtensions, type Config as PluginConfig } from "./config.js";
import { createInstanceLeaseHandler, startInstanceLease } from "./instance-lease.js";
import { startTakeoverPolling } from "./takeover.js";
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
  const config = normalizeConfig(withLauncherNativeExtensions({ ...input, pinnedAdapterId: input.pinnedAdapterId || null }));
  const descriptorPath = connectionDescriptorPath(config.connectionId);
  const launchProfile = await (async () => {
    try { const profile = launcherProjectionProfile(config); await assertRegisteredStartup(config, descriptorPath, profile !== null); return profile; }
    catch (error) { ctx.appExit(1); throw error; }
  })();
  const coreBinding = launcherCoreBinding(config, launchProfile);
  let activeRuntime: RuntimeBrokerPluginClient | undefined;
  const engineGate = new RegisteredSessionWriteAccess(
    async () => { if (!activeRuntime) throw new Error('实例尚未接管'); await activeRuntime.assertReady(); },
    async () => { if (!activeRuntime) throw new Error('实例尚未接管'); await activeRuntime.reconcilePending(); },
  );
  // The gate is always provided, but it only ever holds back a session that a
  // taken-over run froze into this instance's scope. An instance with no run —
  // including one with no Engine at all — takes the open branch and is never
  // blocked, which is what keeps this plugin from making the instance unusable.
  // Until a run is attached and frozen there is no scope to enforce, so the gate
  // has nothing it may hold back.
  let frozenScope: WriteScopePort = openWriteScope;
  const writeAccess = new ScopedSessionWriteAccess({ scope: { decisionFor: target => frozenScope.decisionFor(target) },
    assertWritable: () => engineGate.assertWritable(), onUndecidable: () => undefined });
  {
    (ctx as unknown as Context).provide('sessionWriteAccess' as never, writeAccess as never);
    ctx.effect(() => () => engineGate.close(), 'maintenance: write policy lifetime');
    (ctx as unknown as { on(event: string, handler: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): unknown }).on('agent/pre-step', async (payload, next) => {
      // A host payload this build cannot identify is not gated: a write this
      // plugin cannot attribute must never be the reason an instance stops.
      await writeAccess.assertWritable(writeTargetOf(payload)); return next();
    });
  }
  const connection = descriptorPath === undefined
    ? { current: async () => { throw new Error("维护引擎连接尚未由可信安装器登记"); } }
    : new FileConnectionProvider(descriptorPath);
  const proxy = new RestrictedEngineProxy(config, connection, fetch, launchProfile?.runId);
  await registerMaintenanceBusinessPages(ctx as unknown as Context, connection, {instanceId:config.dshInstanceId,profileId:config.profileId});
  (ctx as unknown as Context).provide("maintenanceReferenceResolver", {
    resolve: (location: import("./engine-proxy.js").ProxyRequest) => proxy.invoke({ ...location, operation: "reference:resolve" }),
  });
  {
    // Takeover handshake. This is deliberately outside the prepared-run block
    // below: the case that matters is an instance started with no Engine at all,
    // which must still leave something the Engine can find once it appears.
    const stateRoot = maintenanceStateRoot(config.connectionId);
    const report = (message: string) => { if (ctx.logger) ctx.logger.warn(message); else console.warn(message); };
    const publisher = await startInstanceLease({ instanceId: config.dshInstanceId, profileId: config.profileId,
      stateRoot, ...(stateRoot === undefined ? {} : { stateRoot }), report });
    if (publisher !== null && stateRoot !== undefined) {
      const unregisterLease = ctx.webServer.register({ kind: "prefix", path: "/dsh-session-maintenance/instance/lease",
        handler: createInstanceLeaseHandler({ identity: publisher.identity, publisher }) });
      const poller = startTakeoverPolling({ identity: publisher.identity, connection: () => connection.current(), publisher, report,
        attach: async (handoff: import("@linmu/dsh-session-contracts").TakeoverHandoff) => {
          // The Engine prepared this run; attaching to it is the next step, and a
          // takeover may only proceed when the run's persistence root matches the
          // one this instance froze at boot. That judgement belongs to the attach
          // path, so it is reported here rather than assumed.
          report(`[dsh-session-maintenance] 引擎已为实例准备运行 ${handoff.runId}；等待接入。`);
        } });
      ctx.effect(() => () => {
        void poller?.stop();
        if (typeof unregisterLease === "function") unregisterLease();
        void publisher.stopping();
      }, "dsh-session-maintenance: takeover handshake");
    }
  }
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
    catch (error) { ctx.appExit(1); throw new Error("此实例已接入 Maintenance，请先启动并确认维护服务就绪。", { cause: error }); }
    activeRuntime = runtime;
    // Now that a run is attached, the Engine's frozen scope is in force. It is
    // captured here and never recomputed, so a later scope change can neither
    // block a session this run admitted nor admit one it did not.
    frozenScope = new FrozenWriteScope({ workspaceIds: launchProfile.scopeWorkspaceIds ?? [],
      includeUnassigned: launchProfile.scopeIncludeUnassigned === true });
    await engineGate.assertWritable();
    ctx.effect(() => {
      const timer = setInterval(() => { void engineGate.assertWritable().catch(() => {}); }, 3000);
      timer.unref();
      return () => { clearInterval(timer); };
    }, 'maintenance: registered instance write policy');
    registerMaintenanceInstanceWorkspace(ctx as unknown as Context, {instanceId:config.dshInstanceId,profileId:config.profileId}, connection);
    const graph = new MaintenanceGraph(connection, launchProfile.runId, async id => {
      const session = ctx.sessions.get(id as never);
      if (!session) throw new Error("新建会话不在当前 DSH 运行环境中");
      await runtime.retainExplicitSession(id, rc2RuntimeHeader(session.header) as unknown as JsonValue,
        { inheritedEventCount: Number(session.inheritedEventCount) });
      await runtime.flush(id);
    });
    registerMaintenanceGraph(ctx as unknown as Context, graph);
    const archiveBridge = registerWorkspaceArchiveBridge(ctx as unknown as Context, graph, () => {
      const message = '[dsh-session-maintenance] 会话归档暂未同步到维护引擎，将自动重试。';
      if (ctx.logger) ctx.logger.warn(message); else console.warn(message);
    });
    if (config.extensionPlugins !== undefined) {
      const extensions = new MaintenanceExtensionBridge(connection,{instanceId:config.dshInstanceId,profileId:config.profileId},config.extensionPlugins);
      if (config.extensionPlugins.some(plugin => plugin.namespace === 'thoughtdag')) {
        (ctx as unknown as Context).provide('sessionExtensionSync' as never, new GraphDataAdapter(extensions, graph) as never);
      }
      {
        // Publish instance-bound capabilities independently of Engine availability.
        // Each operation still goes through the authoritative Engine and its guards.
        await registerMaintenanceExtensionData(ctx as unknown as Context,extensions);
        registerMaintenanceKnowledge(ctx as unknown as Context,new MaintenanceKnowledge(connection,launchProfile.runId,ctx as unknown as Context));
        if(config.extensionPlugins.some(p=>p.namespace==="annotation-upstream")) {
          registerSessionContext(ctx as unknown as Context,new MaintenanceSessionContext(connection,launchProfile.runId,id=>runtime.flush(id)));
        }
        const nativePlugin = config.extensionPlugins.find(p=>p.namespace==="annotation-context");
        if(nativePlugin) {
          registerMaintenanceNativeContext(ctx as unknown as Context,new MaintenanceNativeContext(connection,launchProfile.runId,id=>runtime.flush(id), async signal => {
            if (!nativeContextReady(await extensions.panels(signal), config.dshInstanceId, config.profileId, nativePlugin.pluginVersion))
              throw new Error('原生上下文 Adapter 已停用或不兼容；保存的数据仍然保留');
          }));
        }
      }
      ctx.effect(() => retryExtensionConnect(signal => extensions.connect(signal), () => {
        const message = "[dsh-session-maintenance] 扩展数据暂未接通；将自动重试，未提交编辑保留。";
        if (ctx.logger) ctx.logger.warn(message); else console.warn(message);
      }), "maintenance.extension-registration");
      registerAnnotationMirror(ctx as unknown as AnnotationMirrorContext, {
        plugins: config.extensionPlugins, connection, runId: launchProfile.runId, connect: signal => extensions.connect(signal),
        reportRetry: () => {
          const message = '[dsh-session-maintenance] 引用目录暂未同步，将保留待同步记录并自动重试。';
          if (ctx.logger) ctx.logger.warn(message); else console.warn(message);
        },
      });
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
        rc2RuntimeHeader(session.header) as unknown as JsonValue,
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
      await archiveBridge.dispose();
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
