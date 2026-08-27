import type {
  DshCoreApplyRequest,
  DshCoreExtension,
  DshCoreProbe,
  DshCoreSnapshot,
  DshCoreState,
} from "@linmu/dsh-core-extension";
import { SessionMaintenanceError, type JsonValue } from "@linmu/dsh-session-contracts";
import { canonicalJson } from "@linmu/dsh-session-domain";

import { DshGatewayTokenService } from "./auth.js";
import type {
  DshGatewayRequest,
  DshGatewayScope,
  MaterializationProbe,
} from "./contract.js";

export interface DshHostGatewayOptions {
  readonly extensions: ReadonlyMap<string, DshCoreExtension>;
  readonly tokens: DshGatewayTokenService;
  readonly materializationProbe: MaterializationProbe;
  readonly maxPayloadBytes?: number;
}

export class DshHostGateway {
  readonly extensions: ReadonlyMap<string, DshCoreExtension>;
  readonly tokens: DshGatewayTokenService;
  readonly materializationProbe: MaterializationProbe;
  readonly maxPayloadBytes: number;

  constructor(options: DshHostGatewayOptions) {
    this.extensions = options.extensions;
    this.tokens = options.tokens;
    this.materializationProbe = options.materializationProbe;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 64 * 1024 * 1024;
  }

  async probeInstance(instanceId: string): Promise<DshCoreProbe> {
    const materialization = await this.materializationProbe();
    if (materialization.status !== "compatible") {
      return {
        status: "unsupported",
        contractFingerprint: `${materialization.sourceHash}:${materialization.artifactHash}`,
        capabilities: [],
        issues: materialization.issues,
      };
    }
    return this.extension(instanceId).probe();
  }

  client(scope: DshGatewayScope): DshGatewayClient {
    return new DshGatewayClient(this, scope);
  }

  async invoke(
    token: string,
    scope: DshGatewayScope,
    request: DshGatewayRequest,
  ): Promise<DshCoreSnapshot | DshCoreState> {
    this.tokens.verify(token, scope);
    const bytes = Buffer.byteLength(canonicalJson(request as unknown as JsonValue));
    if (bytes > this.maxPayloadBytes) {
      throw new SessionMaintenanceError(
        "WRITE_CAPABILITY_UNAVAILABLE",
        `DSH gateway payload exceeds ${this.maxPayloadBytes} bytes`,
      );
    }
    const probe = await this.probeInstance(scope.instanceId);
    if (probe.status !== "compatible") {
      throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "DSH Core gateway is incompatible");
    }
    const extension = this.extension(scope.instanceId);
    switch (request.operation) {
      case "capture":
      case "observe":
        return extension.capture({
          instanceId: scope.instanceId,
          sessionId: scope.sessionId,
          ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
        });
      case "apply":
        this.assertSnapshotScope(scope, request.request.snapshot);
        return extension.apply(request.request);
      case "restore":
        this.assertSnapshotScope(scope, request.snapshot);
        return extension.restore({ snapshot: request.snapshot });
    }
  }

  private extension(instanceId: string): DshCoreExtension {
    const extension = this.extensions.get(instanceId);
    if (extension === undefined) {
      throw new SessionMaintenanceError(
        "ADAPTER_INCOMPATIBLE",
        `No DSH Core extension is registered for instance: ${instanceId}`,
      );
    }
    return extension;
  }

  private assertSnapshotScope(scope: DshGatewayScope, snapshot: DshCoreSnapshot): void {
    if (snapshot.instanceId !== scope.instanceId || snapshot.sessionId !== scope.sessionId) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", "DSH gateway snapshot escaped its scope");
    }
  }
}

export class DshGatewayClient {
  readonly gateway: DshHostGateway;
  readonly scope: DshGatewayScope;

  constructor(gateway: DshHostGateway, scope: DshGatewayScope) {
    this.gateway = gateway;
    this.scope = { ...scope };
  }

  capture(workspaceId?: string): Promise<DshCoreSnapshot> {
    return this.call({
      operation: "capture",
      ...(workspaceId === undefined ? {} : { workspaceId }),
    }) as Promise<DshCoreSnapshot>;
  }

  observe(workspaceId?: string): Promise<DshCoreSnapshot> {
    return this.call({
      operation: "observe",
      ...(workspaceId === undefined ? {} : { workspaceId }),
    }) as Promise<DshCoreSnapshot>;
  }

  apply(request: DshCoreApplyRequest): Promise<DshCoreState> {
    return this.call({ operation: "apply", request }) as Promise<DshCoreState>;
  }

  restore(snapshot: DshCoreSnapshot): Promise<DshCoreState> {
    return this.call({ operation: "restore", snapshot }) as Promise<DshCoreState>;
  }

  private call(request: DshGatewayRequest): Promise<DshCoreSnapshot | DshCoreState> {
    return this.gateway.invoke(this.gateway.tokens.issue(this.scope), this.scope, request);
  }
}
