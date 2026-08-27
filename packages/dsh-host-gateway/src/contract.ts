import type {
  CoreHostMaterializationProbe,
  DshCoreApplyRequest,
  DshCoreProbe,
  DshCoreSnapshot,
  DshCoreState,
} from "@linmu/dsh-core-extension";

export interface DshGatewayScope {
  readonly transactionId: string;
  readonly planHash: string;
  readonly instanceId: string;
  readonly sessionId: string;
}

export type DshGatewayRequest =
  | { readonly operation: "capture"; readonly workspaceId?: string }
  | { readonly operation: "apply"; readonly request: DshCoreApplyRequest }
  | { readonly operation: "observe"; readonly workspaceId?: string }
  | { readonly operation: "restore"; readonly snapshot: DshCoreSnapshot };

export type MaterializationProbe = () => Promise<CoreHostMaterializationProbe>;

export interface DshGatewayClientPort {
  capture(workspaceId?: string): Promise<DshCoreSnapshot>;
  observe(workspaceId?: string): Promise<DshCoreSnapshot>;
  apply(request: DshCoreApplyRequest): Promise<DshCoreState>;
  restore(snapshot: DshCoreSnapshot): Promise<DshCoreState>;
}

/**
 * The writer depends on this narrow port rather than the in-process host
 * implementation.  The standalone Engine can therefore use the same writer
 * through a loopback transport without learning DSH filesystem internals.
 */
export interface DshGatewayPort {
  probeInstance(instanceId: string): Promise<DshCoreProbe>;
  client(scope: DshGatewayScope): DshGatewayClientPort;
}

export interface RemoteDshGatewayConnection {
  readonly origin: string;
  readonly secret: Uint8Array;
}

export interface RemoteDshGatewayConnectionProvider {
  current(instanceId: string): Promise<RemoteDshGatewayConnection>;
}
