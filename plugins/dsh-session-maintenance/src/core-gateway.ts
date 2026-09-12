import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type {} from "@deepseek-ai/dsh-workspace";
import type {} from "@deepseek-ai/dsh-session-query";
import type {} from "@deepseek-ai/dsh-session-projection-cache";
import { createDsh015CoreHostBinding, LockedDsh015CoreExtension, type Dsh015CoreBindingInput } from "@linmu/dsh-core-extension";
import { DshGatewayTokenService, DshHostGateway, createDshGatewayHttpHandler } from "@linmu/dsh-host-gateway";
import type { EngineConnectionProvider } from "./engine-proxy.js";

const ENDPOINT = "/dsh-session-maintenance/core";
export interface CoreRuntimeContext extends Pick<Context, "sessions" | "sessionPersistence" | "workspaceRegistry" | "sessionProjectionCache" | "sessionQuery"> {
  readonly webServer: { register(input: { kind: "prefix"; path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }): void | (() => void) };
}
export type CoreBindingRegistration = Omit<Dsh015CoreBindingInput, "runtime" | "importAnchor">;

/** Cheap diagnostic only; compatibility is established by the attested binding. */
export function assertRc2RuntimeSurface(ctx: CoreRuntimeContext): void {
  const method = (value: unknown, name: string) => { if (typeof value !== "function") throw new TypeError(`DSH 0.1.5-rc.2 service drift: ${name}`); };
  method(ctx.sessions?.get, "sessions.get");
  for (const name of ["list", "stat", "open", "create"] as const) method(ctx.sessionPersistence?.[name], `sessionPersistence.${name}`);
  method(ctx.sessionQuery?.readSession, "sessionQuery.readSession");
}

export function createCoreGatewayHandler(input: {
  readonly runtime: CoreRuntimeContext;
  readonly connection: EngineConnectionProvider;
  readonly binding?: CoreBindingRegistration;
}) {
  let binding: Promise<Awaited<ReturnType<typeof createDsh015CoreHostBinding>>> | undefined;
  let extension: LockedDsh015CoreExtension | undefined;
  let disposed = false;
  let tokenState: { readonly capability: string; readonly service: DshGatewayTokenService } | undefined;
  const handler = createDshGatewayHttpHandler({
    endpoint: ENDPOINT,
    createGateway: async expectedScope => {
      if (disposed) throw new TypeError("RC2 Core gateway is disposed");
      if (input.binding === undefined) throw new TypeError("RC2 Core receipt requires a registered Launcher native-space binding");
      if (expectedScope.instanceId !== input.binding.instanceId) throw new TypeError("RC2 Core scope belongs to another instance");
      assertRc2RuntimeSurface(input.runtime);
      const active = await (binding ??= createDsh015CoreHostBinding({ ...input.binding, runtime: input.runtime, importAnchor: import.meta.url }));
      if (disposed) throw new TypeError("RC2 Core gateway is disposed");
      extension ??= new LockedDsh015CoreExtension(active.host, active.expectedContractFingerprint);
      const connection = await input.connection.current();
      if (tokenState?.capability !== connection.token) tokenState = { capability: connection.token, service: new DshGatewayTokenService({ secret: Buffer.from(connection.token) }) };
      return new DshHostGateway({ extensions: new Map([[input.binding.instanceId, extension]]), tokens: tokenState.service, materializationProbe: active.materializationProbe });
    },
  });
  return Object.assign(handler, { dispose: async () => {
    disposed = true;
    if (binding !== undefined) {
      const result = await binding.then(value => ({ value }), () => ({ value: undefined }));
      await result.value?.dispose();
    }
  } });
}
