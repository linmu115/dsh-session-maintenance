import type {
  CompatibilityIssue,
  JsonValue,
  WriteCapability,
} from "@linmu/dsh-session-contracts";

export interface Rc2CoreContractObservation {
  readonly platformVersion: string;
  readonly sessionFormatVersion: number;
  readonly workspaceDomainVersion: number;
  readonly projectionDomainVersion: number;
  readonly querySchemaVersion: number;
  readonly packages: Readonly<Record<
    "@deepseek-ai/dsh-session-persistence" | "@deepseek-ai/dsh-workspace",
    { readonly version: string; readonly integrity: string }
  >>;
  readonly implementationHashes: Readonly<Record<
    | "session"
    | "sessionPersistence"
    | "jsonlPersistence"
    | "workspace"
    | "projectionCache"
    | "querySqlite",
    string
  >>;
  readonly methods: {
    readonly sessionPersistence: readonly string[];
    readonly persistenceCoordinator: readonly string[];
    readonly workspaceRegistry: readonly string[];
    readonly workspaceEntity: readonly string[];
    readonly projectionTable: readonly string[];
    readonly sessionQuery: readonly string[];
  };
}

export interface DshCoreProbe {
  readonly status: "compatible" | "unsupported";
  readonly contractFingerprint: string;
  readonly capabilities: readonly WriteCapability[];
  readonly issues: readonly CompatibilityIssue[];
}

export interface DshNativeSessionHeader {
  readonly version: 0;
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly delegationDepth: number;
  readonly parentSession?: string;
  readonly origin?: "subagent";
  readonly agentPreset?: string;
}

export interface DshNativeEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: JsonValue;
  readonly surfaceOp?: JsonValue;
  readonly sourceEventSeqs?: readonly number[];
  readonly optional?: true;
}

export type DshSessionArtifactCapture =
  | {
      readonly exists: false;
    }
  | {
      readonly exists: true;
      readonly header: DshNativeSessionHeader;
      readonly events: readonly DshNativeEvent[];
      readonly revision: string;
      readonly artifact: string;
    };

export type DshSessionArtifactSnapshot = DshSessionArtifactCapture & {
  readonly sessionId: string;
};

export interface DshWorkspaceSnapshot {
  readonly workspaceId: string | null;
  readonly memberIndex: number | null;
  readonly beforeSessionId: string | null;
  readonly archived: boolean;
}

export type DshProjectionSnapshot =
  | { readonly present: false }
  | { readonly present: true; readonly record: JsonValue };

export interface DshRuntimeSnapshot {
  readonly coordinator: string;
  readonly queryIndex: string;
}

export interface DshCoreState {
  readonly sessionId: string;
  readonly contractFingerprint: string;
  readonly sessionRevision: string | null;
  readonly sessionArtifactHash: string | null;
  readonly eventCount: number;
  readonly workspaceId: string | null;
  readonly workspaceMemberIndex: number | null;
  readonly archived: boolean;
  readonly projectionHash: string | null;
  readonly coordinator: string;
  readonly queryIndex: string;
  readonly digest: string;
}

export interface DshCoreSnapshot {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly contractFingerprint: string;
  readonly session: DshSessionArtifactSnapshot;
  readonly workspace: DshWorkspaceSnapshot;
  readonly projection: DshProjectionSnapshot;
  readonly runtime: DshRuntimeSnapshot;
  readonly before: DshCoreState;
  readonly hash: string;
}

export interface DshCoreCaptureRequest {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly workspaceId?: string;
}

export interface DshCoreApplyRequest {
  readonly snapshot: DshCoreSnapshot;
  readonly header?: DshNativeSessionHeader;
  readonly events: readonly DshNativeEvent[];
  readonly workspaceId?: string;
  readonly archived?: boolean;
}

export interface DshCoreRestoreRequest {
  readonly snapshot: DshCoreSnapshot;
}

export interface DshCoreHost {
  observeContract(): Promise<Rc2CoreContractObservation>;
  isSessionLive(sessionId: string): boolean;
  captureSession(sessionId: string): Promise<DshSessionArtifactCapture>;
  captureWorkspace(sessionId: string, workspaceId?: string): Promise<DshWorkspaceSnapshot>;
  captureProjection(sessionId: string): Promise<DshProjectionSnapshot>;
  captureRuntime(sessionId: string): Promise<DshRuntimeSnapshot>;
  createSession(header: DshNativeSessionHeader): Promise<void>;
  appendEvents(sessionId: string, events: readonly DshNativeEvent[]): Promise<void>;
  attachWorkspace(sessionId: string, workspaceId: string): Promise<void>;
  setArchive(sessionId: string, archived: boolean): Promise<void>;
  invalidateProjection(sessionId: string): Promise<void>;
  reconcileRuntime(sessionId: string): Promise<void>;
  restoreSession(snapshot: DshSessionArtifactSnapshot): Promise<void>;
  restoreWorkspace(sessionId: string, snapshot: DshWorkspaceSnapshot): Promise<void>;
  restoreProjection(sessionId: string, snapshot: DshProjectionSnapshot): Promise<void>;
}

export interface DshCoreExtension {
  probe(): Promise<DshCoreProbe>;
  capture(request: DshCoreCaptureRequest): Promise<DshCoreSnapshot>;
  apply(request: DshCoreApplyRequest): Promise<DshCoreState>;
  restore(request: DshCoreRestoreRequest): Promise<DshCoreState>;
}
