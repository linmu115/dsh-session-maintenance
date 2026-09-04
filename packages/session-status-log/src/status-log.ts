import { randomUUID } from "node:crypto";

import { statusEventQuerySchema } from "@linmu/dsh-session-contracts";

import type {
  AdapterId,
  LeaseId,
  LogicalSessionId,
  NativeSessionId,
  OperationId,
  Page,
  RunId,
  StatusEventId,
  StatusEventQuery,
  StatusEventV1,
  StatusSpanId,
  StatusStage,
} from "@linmu/dsh-session-contracts";

export interface StatusEventAdapter {
  append(input: StatusEventV1): Promise<void>;
  list(query: StatusEventQuery): Promise<Page<StatusEventV1>>;
  subscribe(query: StatusEventQuery, signal?: AbortSignal): AsyncIterable<StatusEventV1>;
}

export interface StartStatusSpanInput {
  readonly runId: RunId;
  readonly leaseId: LeaseId;
  readonly profileId: string;
  readonly adapterId: AdapterId;
  readonly dshVersion: string;
  readonly stage: StatusStage;
  readonly logicalSessionId: LogicalSessionId | null;
  readonly nativeSessionId: NativeSessionId | null;
  readonly operationId: OperationId | null;
  readonly parentEventId?: StatusEventId;
  readonly spanId?: StatusSpanId;
  readonly diagnosticDetailRef?: string;
}

export interface StatusSpanHandle {
  readonly event: StatusEventV1 & { readonly state: "started" };
}

export interface CompleteStatusSpanInput {
  readonly durationMs?: number;
  readonly diagnosticDetailRef?: string;
}

export interface FailStatusSpanInput extends CompleteStatusSpanInput {
  readonly errorCode: string;
}

export interface StatusLogOptions {
  readonly clock?: () => string;
  readonly idFactory?: (kind: "status" | "span") => string;
}

const DETAIL_REF = /^(?:diag|object):[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_.:-]{0,127}$/u;

function detailRef(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!DETAIL_REF.test(value)) {
    throw new TypeError("Diagnostic detail reference must be an opaque diag: or object: identifier");
  }
  return value;
}

function duration(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Status duration must be a non-negative safe integer");
  }
  return value;
}

export function statusEventMatches(event: StatusEventV1, query: StatusEventQuery): boolean {
  return (
    (query.runId === undefined || event.runId === query.runId) &&
    (query.logicalSessionId === undefined || event.logicalSessionId === query.logicalSessionId) &&
    (query.operationId === undefined || event.operationId === query.operationId) &&
    (query.stage === undefined || event.stage === query.stage) &&
    (query.spanId === undefined || event.spanId === query.spanId)
  );
}

export class StatusLog {
  readonly adapter: StatusEventAdapter;
  private readonly clock: () => string;
  private readonly idFactory: (kind: "status" | "span") => string;

  constructor(adapter: StatusEventAdapter, options: StatusLogOptions = {}) {
    this.adapter = adapter;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ((kind) => `${kind}-${randomUUID()}`);
  }

  async start(input: StartStatusSpanInput): Promise<StatusSpanHandle> {
    const event: StatusEventV1 & { readonly state: "started" } = {
      schemaVersion: 1,
      id: this.idFactory("status") as StatusEventId,
      at: this.clock(),
      runId: input.runId,
      leaseId: input.leaseId,
      profileId: input.profileId,
      adapterId: input.adapterId,
      dshVersion: input.dshVersion,
      stage: input.stage,
      state: "started",
      logicalSessionId: input.logicalSessionId,
      nativeSessionId: input.nativeSessionId,
      operationId: input.operationId,
      parentEventId: input.parentEventId ?? null,
      spanId: input.spanId ?? this.idFactory("span") as StatusSpanId,
      errorCode: null,
      durationMs: null,
      diagnosticDetailRef: detailRef(input.diagnosticDetailRef),
    };
    await this.adapter.append(event);
    return { event };
  }

  async succeed(
    handle: StatusSpanHandle,
    input: CompleteStatusSpanInput = {},
  ): Promise<StatusEventV1> {
    return this.terminal(handle, "succeeded", null, input);
  }

  async fail(handle: StatusSpanHandle, input: FailStatusSpanInput): Promise<StatusEventV1> {
    if (!ERROR_CODE.test(input.errorCode)) {
      throw new TypeError("Failed status events require a bounded machine error code");
    }
    return this.terminal(handle, "failed", input.errorCode, input);
  }

  list(query: StatusEventQuery): Promise<Page<StatusEventV1>> {
    return this.adapter.list(statusEventQuerySchema.parse(query) as unknown as StatusEventQuery);
  }

  subscribe(query: StatusEventQuery, signal?: AbortSignal): AsyncIterable<StatusEventV1> {
    return this.adapter.subscribe(statusEventQuerySchema.parse(query) as unknown as StatusEventQuery, signal);
  }

  private async terminal(
    handle: StatusSpanHandle,
    state: "succeeded" | "failed",
    errorCode: string | null,
    input: CompleteStatusSpanInput,
  ): Promise<StatusEventV1> {
    const started = handle.event;
    const event: StatusEventV1 = {
      ...started,
      id: this.idFactory("status") as StatusEventId,
      at: this.clock(),
      state,
      parentEventId: started.id,
      errorCode,
      durationMs: duration(input.durationMs),
      diagnosticDetailRef: detailRef(input.diagnosticDetailRef),
    };
    await this.adapter.append(event);
    return event;
  }
}
