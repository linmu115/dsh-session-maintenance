export type ContinuationAdapterErrorCode =
  | "ADAPTER_INCOMPATIBLE"
  | "CONTINUATION_CREATE_FAILED"
  | "CONTINUATION_VERIFY_FAILED";

export class ContinuationAdapterError extends Error {
  readonly code: ContinuationAdapterErrorCode;
  readonly threadId: string | undefined;

  constructor(
    code: ContinuationAdapterErrorCode,
    message: string,
    options: { readonly threadId?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ContinuationAdapterError";
    this.code = code;
    this.threadId = options.threadId;
  }
}

export interface CodexContinuationTarget {
  readonly id: string;
  readonly platformVersion: string;
  readonly cwd: string;
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly contextWindowTokens: number;
  readonly model?: string;
  readonly permissions?: string;
  readonly codexHome?: string;
  readonly command?: string;
}

export interface ContinuationProbe {
  readonly status: "compatible" | "unsupported";
  readonly platformVersion: string;
  readonly schemaFingerprint: string;
  readonly capabilities: readonly ("create-thread" | "start-turn" | "read-thread")[];
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}

export interface CreatedCodexThread {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: "turn-completed";
  readonly cwd: string;
}

export interface ContinuationVerification {
  readonly ok: true;
  readonly threadId: string;
  readonly cwd: string;
  readonly historyMode: "paginated";
}

export interface AppServerTransport {
  version(): Promise<string>;
  request<T>(method: string, params: unknown): Promise<T>;
  notify(method: string, params?: unknown): Promise<void>;
  waitForNotification<T>(
    method: string,
    predicate: (params: T) => boolean,
    timeoutMs: number,
  ): Promise<T>;
  close(): Promise<void>;
}

export type AppServerTransportFactory = (
  target: CodexContinuationTarget,
) => AppServerTransport;
