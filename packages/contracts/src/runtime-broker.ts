import type {
  AdapterId,
  BranchId,
  LogicalProjectId,
  NativeSessionId,
  RunId,
  SessionVersionId,
} from "./canonical.js";
import type { NativeAppendOperation } from "./adapter-sdk.js";
import type { ProjectionOperationReceipt } from "./projection.js";
import type { JsonValue } from "./model.js";

export type RuntimeBrokerClientKind = "launcher" | "plugin" | "cli";

export type RuntimeBrokerProjectSelection =
  | { readonly kind: "all" }
  | { readonly kind: "ids"; readonly projectIds: readonly LogicalProjectId[] };

export interface RuntimeBrokerPrepareRunRequest {
  readonly schemaVersion: 1;
  readonly client: {
    readonly kind: RuntimeBrokerClientKind;
    readonly id: string;
  };
  /** Separate capability held by the DSH plugin process. */
  readonly runtimeClientId: string;
  readonly instanceId: string;
  readonly profileId: string;
  readonly dshVersion: string;
  readonly maintenanceEndpoint: string;
  readonly branchId: BranchId;
  readonly environment: {
    readonly packageVersions: Readonly<Record<string, string>>;
    readonly runtimeCapabilities: readonly string[];
  };
  readonly pinnedAdapterId: AdapterId | null;
  /** Defaults to all canonical projects for Launcher-owned runs. */
  readonly projectSelection: RuntimeBrokerProjectSelection;
}

export interface RuntimeBrokerPreparedRun {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly leaseId: string;
  readonly adapterId: AdapterId;
  readonly persistenceRoot: string;
  readonly temporaryPersistenceRootId: string;
  readonly runtimeClientId: string;
  readonly state: "preparing";
}

export interface RuntimeBrokerAttachRunRequest {
  readonly schemaVersion: 1;
  readonly clientId: string;
  readonly runId: RunId;
  readonly temporaryPersistenceRootId: string;
  readonly attachedAt: string;
}

export interface RuntimeBrokerAttachedRun {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly state: "running";
  readonly attachedAt: string;
}

export interface RuntimeBrokerAppendRequest {
  readonly schemaVersion: 1;
  readonly clientId: string;
  readonly operation: NativeAppendOperation;
}

export interface RuntimeBrokerRegisterSessionRequest {
  readonly schemaVersion: 1;
  readonly clientId: string;
  readonly runId: RunId;
  readonly nativeSessionId: NativeSessionId;
  /** Exact immutable SessionHeader observed from DSH. */
  readonly header: JsonValue;
  readonly title: string;
  /** Opaque metadata passed only to the selected Adapter. */
  readonly adapterMetadata?: JsonValue;
}

export interface RuntimeBrokerRegisteredSession {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly nativeSessionId: NativeSessionId;
  readonly logicalSessionId: string;
  readonly baseVersionId: SessionVersionId | null;
}

export interface RuntimeBrokerAppendResponse {
  readonly schemaVersion: 1;
  readonly receipt: ProjectionOperationReceipt;
}

export interface RuntimeBrokerFlushRequest {
  readonly schemaVersion: 1;
  readonly clientId: string;
  readonly runId: RunId;
  readonly nativeSessionId: NativeSessionId;
}

export interface RuntimeBrokerFlushResponse {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly nativeSessionId: NativeSessionId;
  readonly pendingOperations: 0;
}

export interface RuntimeBrokerCloseRunRequest {
  readonly schemaVersion: 1;
  readonly clientId: string;
  readonly runId: RunId;
  readonly reason: "normal" | "recovery";
}

export interface RuntimeBrokerDrainRunRequest {
  readonly schemaVersion: 1;
  readonly clientId: string;
  readonly runId: RunId;
  /** Plugin attestation produced only after the official DSH flush resolves. */
  readonly runtimeFlushCompletedAt: string;
}

export interface RuntimeBrokerDrainedRun {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly state: "drained";
  readonly pendingOperations: 0;
  readonly drainedAt: string;
}

export interface RuntimeBrokerClosedRun {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly state: "closed" | "recovered";
  readonly removedProjection: true;
}
