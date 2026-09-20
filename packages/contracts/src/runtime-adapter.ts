import type { DshRuntimeBridgeV1, NativeAppendOperation, RuntimeDrainResult, ProjectionRun, ProjectionReader } from './index.js';
import type { RunId, NativeSessionId, LogicalSessionId, SessionVersionId, JsonValue } from './index.js';

export interface RuntimeAdapterRegistrar {
  attach(input: { readonly runId: RunId; readonly maintenanceEndpoint: string }): Promise<{ readonly registrationId: string; readonly attachedAt: string }>;
  drain(registrationId: string, runId: RunId): Promise<RuntimeDrainResult>;
  detach(registrationId: string, runId: RunId): Promise<void>;
}
export interface RuntimeTailInput {
  readonly runId: RunId; readonly persistenceRoot: string; readonly observedAt: string;
  readonly sessions: readonly {
    readonly nativeSessionId: NativeSessionId; readonly logicalSessionId: LogicalSessionId;
    readonly baseVersionId: SessionVersionId | null; readonly nativeRevision: number;
    readonly header: JsonValue; readonly committedEvents: readonly JsonValue[];
    readonly adapterMetadata?: JsonValue; readonly instanceId?: string;
  }[];
  readonly onIgnoredPreparationArtifact?: (id: NativeSessionId) => void | Promise<void>;
}
/** Format translation only. Engine retains leases, commits, shutdown and authoritative storage. */
export interface RuntimeAdapterHooks {
  createBridge(registrar: RuntimeAdapterRegistrar): DshRuntimeBridgeV1;
  bindAppend?(operation: NativeAppendOperation, run: ProjectionRun, reader: Pick<ProjectionReader, 'readSession'>): Promise<NativeAppendOperation>;
  recoverTail(input: RuntimeTailInput): Promise<readonly NativeAppendOperation[]>;
}
