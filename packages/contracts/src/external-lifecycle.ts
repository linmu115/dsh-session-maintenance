export type ExternalLifecyclePhase = "prepare" | "beforeStop" | "afterExit" | "abort";

export interface ExternalLifecyclePrepareRequest {
  readonly schemaVersion: 1;
  readonly phase: "prepare";
  readonly instanceId: string;
  readonly profileId: string;
  readonly runtimeVersion: string;
  readonly web: boolean;
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
