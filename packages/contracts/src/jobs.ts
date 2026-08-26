import type { JsonValue } from "./model.js";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface JobRef {
  readonly id: string;
  readonly status: JobStatus;
}

export interface JobEventBase {
  readonly jobId: string;
  readonly sequence: number;
  readonly at: string;
}

export type JobEvent =
  | (JobEventBase & { readonly type: "queued" | "running" })
  | (JobEventBase & {
      readonly type: "progress";
      readonly current: number;
      readonly total?: number;
      readonly message: string;
    })
  | (JobEventBase & { readonly type: "completed"; readonly result: JsonValue })
  | (JobEventBase & { readonly type: "failed"; readonly code: string; readonly message: string });
