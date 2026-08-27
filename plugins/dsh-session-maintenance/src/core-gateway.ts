import type { IncomingMessage, ServerResponse } from "node:http";

import {
  LockedRc2CoreExtension,
  RC2_CORE_CONTRACT_OBSERVATION,
  Rc2CoreHost,
  probeBuiltRc2CoreHost,
  type Rc2RuntimeContext,
} from "@linmu/dsh-core-extension";
import {
  DshGatewayTokenService,
  DshHostGateway,
  createDshGatewayHttpHandler,
} from "@linmu/dsh-host-gateway";

import type { EngineConnectionProvider } from "./engine-proxy.js";

const ENDPOINT = "/dsh-session-maintenance/core";

export interface CoreRuntimeContext extends Rc2RuntimeContext {
  readonly webServer: { register(input: { kind: "prefix"; path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }): void | (() => void) };
}

function method(value: unknown, name: string): void {
  if (typeof value !== "function") throw new TypeError(`DSH rc.2 Core service drift: ${name}`);
}

export function assertRc2RuntimeSurface(ctx: Rc2RuntimeContext): void {
  method(ctx.sessions?.get, "sessions.get");
  for (const name of ["list", "inspect", "locate", "create", "append"] as const) method(ctx.sessionPersistence?.[name], `sessionPersistence.${name}`);
  method(ctx.sessionPersistence?.coordinator?.serialize, "sessionPersistence.coordinator.serialize");
  method(ctx.sessionPersistence?.coordinator?.preparations?.invalidate, "sessionPersistence.coordinator.preparations.invalidate");
  for (const name of ["list", "get", "archiveSession", "setState", "enqueueOperation", "replaceHeaderIndex"] as const) method(ctx.workspaceRegistry?.[name], `workspaceRegistry.${name}`);
  for (const name of ["get", "put", "delete"] as const) method(ctx.sessionProjectionCache?.table?.[name], `sessionProjectionCache.table.${name}`);
  for (const name of ["_ensureReady", "_reconcile", "_serialized"] as const) method(ctx.sessionQuery?.[name], `sessionQuery.${name}`);
}

export function createCoreGatewayHandler(input: {
  readonly runtime: Rc2RuntimeContext;
  readonly connection: EngineConnectionProvider;
}) {
  let extension: LockedRc2CoreExtension | undefined;
  let surfaceError: string | undefined;
  let tokenState: { readonly capability: string; readonly service: DshGatewayTokenService } | undefined;
  try {
    assertRc2RuntimeSurface(input.runtime);
    extension = new LockedRc2CoreExtension(new Rc2CoreHost(input.runtime, RC2_CORE_CONTRACT_OBSERVATION));
  } catch (error) {
    surfaceError = error instanceof Error ? error.message : "DSH rc.2 Core service surface is unavailable";
  }
  return createDshGatewayHttpHandler({
    endpoint: ENDPOINT,
    createGateway: async (expectedScope) => {
      if (extension === undefined) throw new TypeError(surfaceError ?? "DSH rc.2 Core service surface is unavailable");
      const connection = await input.connection.current();
      if (tokenState?.capability !== connection.token) {
        tokenState = {
          capability: connection.token,
          service: new DshGatewayTokenService({ secret: Buffer.from(connection.token) }),
        };
      }
      return new DshHostGateway({
        extensions: new Map([[expectedScope.instanceId, extension]]),
        tokens: tokenState.service,
        materializationProbe: probeBuiltRc2CoreHost,
      });
    },
  });
}
