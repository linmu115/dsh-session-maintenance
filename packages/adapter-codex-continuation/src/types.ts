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

import type {
  CodexContinuationTarget,
  ContinuationProbe,
  ContinuationVerification,
  CreatedCodexThread,
} from "@linmu/dsh-session-contracts";

export type {
  CodexContinuationTarget,
  ContinuationProbe,
  ContinuationVerification,
  CreatedCodexThread,
} from "@linmu/dsh-session-contracts";

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
