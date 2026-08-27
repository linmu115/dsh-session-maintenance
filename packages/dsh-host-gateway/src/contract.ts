import type {
  CoreHostMaterializationProbe,
  DshCoreApplyRequest,
  DshCoreSnapshot,
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
