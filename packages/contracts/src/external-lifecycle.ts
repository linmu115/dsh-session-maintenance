export type ExternalLifecyclePhase = "prepare" | "recoverBeforeStart" | "started" | "beforeStop" | "afterExit" | "abort";

export interface ExternalLifecycleRecoveryRequest {
  readonly schemaVersion: 1;
  readonly phase: "recoverBeforeStart";
  readonly instanceId: string;
  readonly profileId: string;
}

export interface ExternalLifecycleStartedRequest {
  readonly schemaVersion: 1;
  readonly phase: "started";
  readonly handle: string;
  readonly processId: number;
}

export interface ExternalLifecyclePrepareRequest {
  readonly schemaVersion: 1;
  readonly phase: "prepare";
  readonly instanceId: string;
  readonly profileId: string;
  readonly runtimeVersion: string;
  readonly web: boolean;
  /** Stable launcher policy, independent from the repairable Engine binding. */
  readonly maintenanceRequired?: boolean;
}

export interface ExternalLifecycleBeforeStopRequest {
  readonly schemaVersion: 1;
  readonly phase: "beforeStop";
  readonly handle: string;
  readonly runtimeUrl: string | null;
}

export interface ExternalLifecycleAfterExitRequest {
  readonly schemaVersion: 1;
  readonly phase: "afterExit";
  readonly handle: string;
  readonly exitCode: number | null;
  readonly requestedStop: boolean;
  readonly forced: boolean;
}

export interface ExternalLifecycleAbortRequest {
  readonly schemaVersion: 1;
  readonly phase: "abort";
  readonly handle: string;
  readonly reason: "spawn-failed";
}

export type ExternalLifecycleRequest =
  | ExternalLifecyclePrepareRequest
  | ExternalLifecycleRecoveryRequest
  | ExternalLifecycleStartedRequest
  | ExternalLifecycleBeforeStopRequest
  | ExternalLifecycleAfterExitRequest
  | ExternalLifecycleAbortRequest;

export interface ExternalLifecyclePrepareResponse {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly handle: string | null;
  readonly launch: {
    /** DSH launcher options inserted before `--profile`. */
    readonly launcherArgs?: readonly string[];
    /** Selected profile application options appended after Launcher-owned app arguments. */
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  } | null;
}

export interface ExternalLifecycleBeforeStopResponse {
  readonly schemaVersion: 1;
  readonly action: "wait" | "force";
  readonly timeoutMs?: number;
}

export interface ExternalLifecycleAcknowledgement {
  readonly schemaVersion: 1;
  readonly ok: true;
}

export type ExternalLifecycleResponse =
  | ExternalLifecyclePrepareResponse
  | ExternalLifecycleBeforeStopResponse
  | ExternalLifecycleAcknowledgement;
