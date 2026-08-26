import type {
  AdapterContractRef,
  PlatformSessionKey,
  StateFingerprint,
} from "./model.js";

export interface BindingSnapshot {
  readonly bindingId: string;
  readonly key: PlatformSessionKey;
  readonly versionId: string;
  readonly fingerprints: readonly StateFingerprint[];
}

export interface ConfirmationRequirement {
  readonly kind: "review" | "destructive";
  readonly code: string;
  readonly message: string;
}

export type PlannedOperation =
  | { readonly type: "create-target-session"; readonly targetInstanceId: string }
  | {
      readonly type: "append-events";
      readonly fromIndex: number;
      readonly eventIds: readonly string[];
    }
  | { readonly type: "update-title"; readonly title: string }
  | { readonly type: "update-archive"; readonly archived: boolean }
  | { readonly type: "deletion-candidate"; readonly missing: PlatformSessionKey }
  | {
      readonly type: "require-review";
      readonly reason: "DIVERGED" | "REWRITTEN" | "METADATA_CONFLICT" | "IDENTITY_CONFLICT";
    };

export interface ScanRequest {
  readonly instanceIds: readonly string[];
}

export interface DiffRequest {
  readonly logicalSessionId: string;
  readonly sourceBindingId?: string;
  readonly targetBindingId?: string;
}

export interface PlanRequest extends DiffRequest {
  readonly sourceBindingId: string;
  readonly createdAt: string;
}

export interface SyncPlan {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly hash: string;
  readonly createdAt: string;
  readonly logicalSessionId: string;
  readonly baseVersionId?: string;
  readonly source: BindingSnapshot;
  readonly target?: BindingSnapshot;
  readonly adapterContracts: readonly AdapterContractRef[];
  readonly operations: readonly PlannedOperation[];
  readonly risk: "safe" | "review" | "destructive";
  readonly confirmations: readonly ConfirmationRequirement[];
  readonly preconditions: readonly StateFingerprint[];
}
