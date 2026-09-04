import type {
  DshRuntimeBridgeV1,
  RuntimeAttachContext,
  RuntimeDrainResult,
  RuntimeHandle,
} from "@linmu/dsh-session-contracts";

export function defineDshRuntimeBridge<T extends DshRuntimeBridgeV1>(bridge: T): T {
  return bridge;
}

export type {
  DshRuntimeBridgeV1,
  RuntimeAttachContext,
  RuntimeDrainResult,
  RuntimeHandle,
};
