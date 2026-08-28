import { z, type ZodType } from "zod";

import {
  apiErrorResponseSchema,
  checkpointListResponseSchema,
  checkpointResponseSchema,
  continuationJobResponseSchema,
  continuationPreviewResponseSchema,
  diagnosticsResponseSchema,
  dashboardLaunchResponseSchema,
  dashboardUiSessionResponseSchema,
  platformSessionResolutionResponseSchema,
  issuedConfirmationSchema,
  jobAcceptedResponseSchema,
  jobRefSchema,
  overviewResponseSchema,
  nativeMirrorListResponseSchema,
  nativeMirrorPreviewResponseSchema,
  nativeMirrorResponseSchema,
  pageSchema,
  planResponseSchema,
  planListResponseSchema,
  sessionDetailResponseSchema,
  sessionDiffSchema,
  sessionSummarySchema,
  settingsResponseSchema,
  transactionDetailResponseSchema,
  transactionListResponseSchema,
  versionContentResponseSchema,
  versionGraphResponseSchema,
  type AdapterDiagnostic,
  type Checkpoint,
  type CheckpointRestoreRequest,
  type CreateCheckpointRequest,
  type DiffRequest,
  type ContinuationJob,
  type ContinuationPreview,
  type ContinuationPreviewRequest,
  type CreateContinuationRequest,
  type JobEvent,
  type JobRef,
  type IssuedConfirmation,
  type DashboardOverview,
  type DashboardLaunchInfo,
  type MaintenanceSettings,
  type MaintenanceSettingsPatch,
  type NativeMirrorActionPreview,
  type NativeMirrorActionRequest,
  type NativeMirrorRecord,
  type Page,
  type PlanRequest,
  type PlanQuery,
  type PlanSummary,
  type PlatformSessionResolution,
  type ResolutionContinuationRequest,
  type SessionDiff,
  type SessionQuery,
  type SessionSummary,
  type SessionDetail,
  type SyncPlan,
  type TransactionDetail,
  type TransactionQuery,
  type TransactionSummary,
  type VersionContent,
  type VersionGraphPage,
} from "@linmu/dsh-session-contracts";

import { decodeJobEventStream } from "./event-stream.js";

export interface MaintenanceClientOptions {
  readonly origin: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

export interface DashboardClientOptions {
  readonly origin: string;
  readonly fetchImpl?: typeof fetch;
}

interface ClientTransport {
  readonly secret: string;
  decorate(init: RequestInit): RequestInit;
}

interface ApiClientOptions {
  readonly origin: string;
  readonly transport: ClientTransport;
  readonly fetchImpl?: typeof fetch;
}

function bearerTransport(token: string): ClientTransport {
  return {
    secret: token,
    decorate: (init) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      return { ...init, headers };
    },
  };
}

function dashboardTransport(csrfToken: string): ClientTransport {
  return {
    secret: csrfToken,
    decorate: (init) => {
      const headers = new Headers(init.headers);
      headers.set("x-dsh-csrf", csrfToken);
      return { ...init, headers, credentials: "same-origin" };
    },
  };
}

const diffResponseSchema = z.strictObject({ diff: sessionDiffSchema });
const jobResponseSchema = z.strictObject({ job: jobRefSchema, result: z.unknown().optional() });
const confirmationResponseSchema = z.strictObject({ confirmation: issuedConfirmationSchema });

class ApiClient {
  private readonly origin: string;
  private readonly transport: ClientTransport;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.origin = options.origin.replace(/\/$/u, "");
    this.transport = options.transport;
    const implementation = options.fetchImpl ?? fetch;
    // Keep the browser-native fetch detached from ApiClient. Calling a stored
    // Web API function as `this.fetchImpl(...)` otherwise supplies ApiClient as
    // its receiver and Chromium rejects the request with "Illegal invocation".
    this.fetchImpl = (input, init) => implementation(input, init);
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

  async overview(signal?: AbortSignal): Promise<DashboardOverview> {
    return (await this.request("/v1/overview", {}, overviewResponseSchema, signal)).overview as DashboardOverview;
  }

  async listNativeMirrors(signal?: AbortSignal): Promise<readonly NativeMirrorRecord[]> {
    return (await this.request("/v1/mirrors", {}, nativeMirrorListResponseSchema, signal)).mirrors as readonly NativeMirrorRecord[];
  }

  async getNativeMirror(id: string, signal?: AbortSignal): Promise<NativeMirrorRecord | undefined> {
    try {
      return (await this.request(`/v1/mirrors/${encodeURIComponent(id)}`, {}, nativeMirrorResponseSchema, signal)).mirror as NativeMirrorRecord;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("MIRROR_NOT_ENABLED:")) return undefined;
      throw error;
    }
  }

  async previewNativeMirrorAction(id: string, input: NativeMirrorActionRequest, signal?: AbortSignal): Promise<NativeMirrorActionPreview> {
    return (await this.request(`/v1/mirrors/${encodeURIComponent(id)}/preview`, this.jsonPost(input), nativeMirrorPreviewResponseSchema, signal)).preview as NativeMirrorActionPreview;
  }

  async applyNativeMirrorAction(id: string, input: NativeMirrorActionRequest, signal?: AbortSignal): Promise<NativeMirrorRecord> {
    return (await this.request(`/v1/mirrors/${encodeURIComponent(id)}/actions`, this.jsonPost(input), nativeMirrorResponseSchema, signal)).mirror as NativeMirrorRecord;
  }

  async getSession(id: string, signal?: AbortSignal): Promise<SessionDetail> {
    return (await this.request(
      `/v1/sessions/${encodeURIComponent(id)}`,
      {},
      sessionDetailResponseSchema,
      signal,
    )).session as SessionDetail;
  }

  async getVersion(id: string, versionId: string, signal?: AbortSignal): Promise<VersionContent> {
    return (await this.request(
      `/v1/sessions/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,
      {},
      versionContentResponseSchema,
      signal,
    )).version as VersionContent;
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

  async previewResolutionContinuation(
    input: ResolutionContinuationRequest,
    signal?: AbortSignal,
  ): Promise<ContinuationPreview> {
    const response = await this.request(
      "/v1/continuations/resolutions/preview",
      this.jsonPost(input),
      continuationPreviewResponseSchema,
      signal,
    );
    return response.preview as unknown as ContinuationPreview;
  }

  async createResolutionContinuation(
    input: ResolutionContinuationRequest,
    signal?: AbortSignal,
  ): Promise<ContinuationJob> {
    const response = await this.request(
      "/v1/continuations/resolutions",
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

  async listPlans(query: PlanQuery = {}, signal?: AbortSignal): Promise<Page<PlanSummary>> {
    const search = new URLSearchParams();
    if (query.cursor !== undefined) search.set("cursor", query.cursor);
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    if (query.risk !== undefined) search.set("risk", query.risk);
    return (await this.request(
      `/v1/plans${search.size === 0 ? "" : `?${search}`}`,
      {},
      planListResponseSchema,
      signal,
    )).page as unknown as Page<PlanSummary>;
  }

  async applyPlan(id: string, signal?: AbortSignal): Promise<JobRef> {
    return (await this.request(
      `/v1/plans/${encodeURIComponent(id)}/apply`,
      this.jsonPost({}),
      jobAcceptedResponseSchema,
      signal,
    )).job;
  }

  async listTransactions(
    query: TransactionQuery = {},
    signal?: AbortSignal,
  ): Promise<Page<TransactionSummary>> {
    const search = new URLSearchParams();
    if (query.cursor !== undefined) search.set("cursor", query.cursor);
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    if (query.status !== undefined) search.set("status", query.status);
    const value = await this.request(
      `/v1/transactions${search.size === 0 ? "" : `?${search}`}`,
      {},
      transactionListResponseSchema,
      signal,
    );
    return value.page as unknown as Page<TransactionSummary>;
  }

  async getTransaction(id: string, signal?: AbortSignal): Promise<TransactionDetail> {
    return (await this.request(
      `/v1/transactions/${encodeURIComponent(id)}`,
      {},
      transactionDetailResponseSchema,
      signal,
    )).detail as TransactionDetail;
  }

  async requestRestoreConfirmation(id: string, signal?: AbortSignal): Promise<IssuedConfirmation> {
    return (await this.request(
      `/v1/transactions/${encodeURIComponent(id)}/restore-confirmation`,
      this.jsonPost({}),
      confirmationResponseSchema,
      signal,
    )).confirmation as IssuedConfirmation;
  }

  async restoreTransaction(id: string, confirmationToken: string, signal?: AbortSignal): Promise<JobRef> {
    return (await this.request(
      `/v1/transactions/${encodeURIComponent(id)}/restore`,
      this.jsonPost({ confirmationToken }),
      jobAcceptedResponseSchema,
      signal,
    )).job;
  }

  async requestRecoveryConfirmation(id: string, signal?: AbortSignal): Promise<IssuedConfirmation> {
    return (await this.request(
      `/v1/transactions/${encodeURIComponent(id)}/recovery-confirmation`,
      this.jsonPost({}),
      confirmationResponseSchema,
      signal,
    )).confirmation as IssuedConfirmation;
  }

  async recoverTransaction(id: string, confirmationToken: string, signal?: AbortSignal): Promise<JobRef> {
    return (await this.request(
      `/v1/transactions/${encodeURIComponent(id)}/recover`,
      this.jsonPost({ confirmationToken }),
      jobAcceptedResponseSchema,
      signal,
    )).job;
  }

  async listCheckpoints(signal?: AbortSignal): Promise<readonly Checkpoint[]> {
    return (await this.request("/v1/checkpoints", {}, checkpointListResponseSchema, signal)).checkpoints as readonly Checkpoint[];
  }

  async createCheckpoint(input: CreateCheckpointRequest, signal?: AbortSignal): Promise<Checkpoint> {
    return (await this.request(
      "/v1/checkpoints",
      this.jsonPost(input),
      checkpointResponseSchema,
      signal,
    )).checkpoint as Checkpoint;
  }

  async createCheckpointRestorePlan(
    input: CheckpointRestoreRequest,
    signal?: AbortSignal,
  ): Promise<SyncPlan> {
    return (await this.request(
      `/v1/checkpoints/${encodeURIComponent(input.checkpointId)}/restore-plan`,
      this.jsonPost({ targetInstanceId: input.targetInstanceId, createdAt: input.createdAt }),
      planResponseSchema,
      signal,
    )).plan as unknown as SyncPlan;
  }

  async diagnostics(signal?: AbortSignal): Promise<readonly AdapterDiagnostic[]> {
    return (await this.request(
      "/v1/diagnostics/adapters",
      {},
      diagnosticsResponseSchema,
      signal,
    )).diagnostics as readonly AdapterDiagnostic[];
  }

  async getSettings(signal?: AbortSignal): Promise<MaintenanceSettings> {
    return (await this.request("/v1/settings", {}, settingsResponseSchema, signal)).settings as MaintenanceSettings;
  }

  async patchSettings(input: MaintenanceSettingsPatch, signal?: AbortSignal): Promise<MaintenanceSettings> {
    return (await this.request(
      "/v1/settings",
      this.jsonPatch(input),
      settingsResponseSchema,
      signal,
    )).settings as MaintenanceSettings;
  }

  async scan(instanceIds: readonly string[], signal?: AbortSignal): Promise<JobRef> {
    return (await this.request("/v1/jobs/scan", this.jsonPost({ instanceIds }), jobAcceptedResponseSchema, signal)).job;
  }

  async getJob(id: string, signal?: AbortSignal): Promise<JobRef> {
    return (await this.request(`/v1/jobs/${encodeURIComponent(id)}`, {}, jobResponseSchema, signal)).job as JobRef;
  }

  async *subscribe(id: string, options: { readonly after?: number; readonly signal?: AbortSignal } = {}): AsyncIterable<JobEvent> {
    const after = options.after === undefined ? "" : `?after=${options.after}`;
    const response = await this.fetchImpl(`${this.origin}/v1/jobs/${encodeURIComponent(id)}/events${after}`, this.transport.decorate({
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }));
    if (!response.ok || response.body === null) await this.throwResponse(response);
    for await (const event of decodeJobEventStream(response.body!)) yield event;
  }

  protected jsonPost(value: unknown): RequestInit {
    return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
  }

  private jsonPatch(value: unknown): RequestInit {
    return { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
  }

  protected async request<T>(path: string, init: RequestInit, schema: ZodType<T>, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchImpl(`${this.origin}${path}`, this.transport.decorate({
      ...init,
      ...(signal === undefined ? {} : { signal }),
    }));
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
    throw new Error(message.replaceAll(this.transport.secret, "[REDACTED]"));
  }
}

export class MaintenanceClient extends ApiClient {
  constructor(options: MaintenanceClientOptions) {
    super({
      origin: options.origin,
      transport: bearerTransport(options.token),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }

  async resolveDshSession(instanceId: string, sessionId: string, signal?: AbortSignal): Promise<PlatformSessionResolution> {
    return (await this.request(
      "/v1/session-resolution",
      this.jsonPost({ platform: "dsh", instanceId, sessionId }),
      platformSessionResolutionResponseSchema,
      signal,
    )).resolution as PlatformSessionResolution;
  }

  async createDashboardLaunchCode(logicalSessionId?: string, signal?: AbortSignal): Promise<DashboardLaunchInfo> {
    return (await this.request(
      "/v1/ui/launch-code",
      this.jsonPost(logicalSessionId === undefined ? {} : { logicalSessionId }),
      dashboardLaunchResponseSchema,
      signal,
    )).launch as DashboardLaunchInfo;
  }
}

export class DashboardClient extends ApiClient {
  readonly initialLogicalSessionId: string | undefined;

  private constructor(options: DashboardClientOptions & { readonly csrfToken: string; readonly initialLogicalSessionId?: string }) {
    super({
      origin: options.origin,
      transport: dashboardTransport(options.csrfToken),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    this.initialLogicalSessionId = options.initialLogicalSessionId;
  }

  static async connect(options: DashboardClientOptions, signal?: AbortSignal): Promise<DashboardClient> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${options.origin.replace(/\/$/u, "")}/v1/ui/session`, {
      credentials: "same-origin",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw new Error(`Dashboard session bootstrap failed with HTTP ${response.status}`);
    const parsed = dashboardUiSessionResponseSchema.parse(await response.json());
    return new DashboardClient({
      origin: options.origin,
      csrfToken: parsed.session.csrfToken,
      ...(parsed.session.initialLogicalSessionId === undefined ? {} : { initialLogicalSessionId: parsed.session.initialLogicalSessionId }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }
}
