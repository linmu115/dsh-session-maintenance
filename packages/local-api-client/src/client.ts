import { z, type ZodType } from "zod";

import {
  apiErrorResponseSchema,
  continuationJobResponseSchema,
  continuationPreviewResponseSchema,
  jobAcceptedResponseSchema,
  jobRefSchema,
  pageSchema,
  planResponseSchema,
  sessionDiffSchema,
  sessionSummarySchema,
  versionGraphResponseSchema,
  type DiffRequest,
  type ContinuationJob,
  type ContinuationPreview,
  type ContinuationPreviewRequest,
  type CreateContinuationRequest,
  type JobEvent,
  type JobRef,
  type Page,
  type PlanRequest,
  type SessionDiff,
  type SessionQuery,
  type SessionSummary,
  type SyncPlan,
  type VersionGraphPage,
} from "@linmu/dsh-session-contracts";

import { decodeJobEventStream } from "./event-stream.js";

export interface MaintenanceClientOptions {
  readonly origin: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

const diffResponseSchema = z.strictObject({ diff: sessionDiffSchema });
const jobResponseSchema = z.strictObject({ job: jobRefSchema, result: z.unknown().optional() });

export class MaintenanceClient {
  private readonly origin: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MaintenanceClientOptions) {
    this.origin = options.origin.replace(/\/$/u, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listSessions(query: SessionQuery = {}, signal?: AbortSignal): Promise<Page<SessionSummary>> {
    const search = new URLSearchParams();
    if (query.cursor !== undefined) search.set("cursor", query.cursor);
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    if (query.platform !== undefined) search.set("platform", query.platform);
    if (query.status !== undefined) search.set("status", query.status);
    const value = await this.request(`/v1/sessions${search.size === 0 ? "" : `?${search}`}`, {}, z.strictObject({ page: pageSchema(sessionSummarySchema) }), signal);
    return value.page as unknown as Page<SessionSummary>;
  }

  async getGraph(id: string, cursor?: string, signal?: AbortSignal): Promise<VersionGraphPage> {
    const suffix = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    return (await this.request(`/v1/sessions/${encodeURIComponent(id)}/graph${suffix}`, {}, versionGraphResponseSchema, signal)).graph as unknown as VersionGraphPage;
  }

  async getDiff(input: DiffRequest, signal?: AbortSignal): Promise<SessionDiff> {
    return (await this.request("/v1/diffs", this.jsonPost(input), diffResponseSchema, signal)).diff as unknown as SessionDiff;
  }

  async createPlan(input: PlanRequest, signal?: AbortSignal): Promise<SyncPlan> {
    return (await this.request("/v1/plans", this.jsonPost(input), planResponseSchema, signal)).plan as unknown as SyncPlan;
  }

  async previewContinuation(input: ContinuationPreviewRequest, signal?: AbortSignal): Promise<ContinuationPreview> {
    const response = await this.request(
      "/v1/continuations/preview",
      this.jsonPost(input),
      continuationPreviewResponseSchema,
      signal,
    );
    return response.preview as unknown as ContinuationPreview;
  }

  async createContinuation(input: CreateContinuationRequest, signal?: AbortSignal): Promise<ContinuationJob> {
    const response = await this.request(
      "/v1/continuations",
      this.jsonPost(input),
      continuationJobResponseSchema,
      signal,
    );
    return response.continuation as unknown as ContinuationJob;
  }

  async getContinuation(id: string, signal?: AbortSignal): Promise<ContinuationJob> {
    const response = await this.request(
      `/v1/continuations/${encodeURIComponent(id)}`,
      {},
      continuationJobResponseSchema,
      signal,
    );
    return response.continuation as unknown as ContinuationJob;
  }

  async recoverContinuation(id: string, signal?: AbortSignal): Promise<ContinuationJob> {
    const response = await this.request(
      `/v1/continuations/${encodeURIComponent(id)}/recover`,
      this.jsonPost({}),
      continuationJobResponseSchema,
      signal,
    );
    return response.continuation as unknown as ContinuationJob;
  }

  async getPlan(id: string, signal?: AbortSignal): Promise<SyncPlan> {
    return (await this.request(`/v1/plans/${encodeURIComponent(id)}`, {}, planResponseSchema, signal)).plan as unknown as SyncPlan;
  }

  async scan(instanceIds: readonly string[], signal?: AbortSignal): Promise<JobRef> {
    return (await this.request("/v1/jobs/scan", this.jsonPost({ instanceIds }), jobAcceptedResponseSchema, signal)).job;
  }

  async getJob(id: string, signal?: AbortSignal): Promise<JobRef> {
    return (await this.request(`/v1/jobs/${encodeURIComponent(id)}`, {}, jobResponseSchema, signal)).job as JobRef;
  }

  async *subscribe(id: string, options: { readonly after?: number; readonly signal?: AbortSignal } = {}): AsyncIterable<JobEvent> {
    const after = options.after === undefined ? "" : `?after=${options.after}`;
    const response = await this.fetchImpl(`${this.origin}/v1/jobs/${encodeURIComponent(id)}/events${after}`, {
      headers: { authorization: `Bearer ${this.token}` },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok || response.body === null) await this.throwResponse(response);
    for await (const event of decodeJobEventStream(response.body!)) yield event;
  }

  private jsonPost(value: unknown): RequestInit {
    return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
  }

  private async request<T>(path: string, init: RequestInit, schema: ZodType<T>, signal?: AbortSignal): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    const response = await this.fetchImpl(`${this.origin}${path}`, {
      ...init,
      headers,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) await this.throwResponse(response);
    return schema.parse(await response.json());
  }

  private async throwResponse(response: Response): Promise<never> {
    let message = `Maintenance API request failed with HTTP ${response.status}`;
    try {
      const parsed = apiErrorResponseSchema.parse(await response.json());
      message = `${parsed.error.code}: ${parsed.error.message}`;
    } catch {
      // Keep the bounded status-only message; never include response bodies or the token.
    }
    throw new Error(message.replaceAll(this.token, "[REDACTED]"));
  }
}
