import type { ExtensionPanel, ExtensionScope, ExtensionConnect, ExtensionList, ExtensionPage, ExtensionDetail, ExtensionWrite, ExtensionWriteResult, ExtensionConflict } from "@linmu/dsh-session-contracts";
import { z, type ZodType } from "zod";

import {
  type CodexImportRequest,
  type RetentionPreviewPlan,
  type RetentionBatch,
  type RetentionRegistry,
  type RetentionRoot,
  type RetentionSource,
  type RetentionResource,
  type RetentionDiscoveryResult,
  retentionRootRegistrationSchema,
  retentionSourceRegistrationSchema,
  apiErrorResponseSchema,
  checkpointListResponseSchema,
  checkpointRestoreCapabilityResponseSchema,
  checkpointResponseSchema,
  canonicalDashboardSessionResponseSchema,
  canonicalWorkspaceDirectoryResponseSchema,
  canonicalProjectDirectoryResponseSchema,
  continuationJobResponseSchema,
  continuationPreviewResponseSchema,
  diagnosticsResponseSchema,
  dashboardLaunchResponseSchema,
  dashboardUiSessionResponseSchema,
  platformSessionResolutionResponseSchema,
  issuedConfirmationSchema,
  jobAcceptedResponseSchema,
  jobRefSchema,
  jobListResponseSchema,
  overviewResponseSchema,
  pageSchema,
  planResponseSchema,
  planListResponseSchema,
  sessionDetailResponseSchema,
  sessionDiffSchema,
  sessionSummarySchema,
  workspaceSummarySchema,
  settingsResponseSchema,
  transactionDetailResponseSchema,
  transactionListResponseSchema,
  versionContentResponseSchema,
  versionGraphResponseSchema,
  type AdapterDiagnostic,
  type Checkpoint,
  type CheckpointRestoreCapability,
  type CanonicalDashboardSessionDetail,
  type CanonicalWorkspaceDirectory,
  type CanonicalProjectDirectory,
  type CanonicalSessionMaintenancePatch,
  type CanonicalSessionDeleteResult,
  type CanonicalSessionRestoreResult,
  type RecentlyDeletedSession,
  type RunCenterItem,
  type AdapterDashboardRecord,
  type AdapterExperimentalSelectionResponse,
  type CheckpointRestoreRequest,
  type CreateCheckpointRequest,
  type DiffRequest,
  type ContinuationJob,
  type ContinuationPreview,
  type ContinuationPreviewRequest,
  type CreateContinuationRequest,
  type JobEvent,
  type JobRef,
  type JobSummary,
  type IssuedConfirmation,
  type DashboardOverview,
  type DashboardLaunchInfo,
  type MaintenanceSettings,
  type MaintenanceSettingsPatch,
  type Page,
  type PlanRequest,
  type PlanQuery,
  type PlanSummary,
  type PlatformSessionResolution,
  type ResolutionContinuationRequest,
  type SessionDiff,
  type SessionQuery,
  type SessionSummary,
  type WorkspaceSummary,
  type SessionDetail,
  type SyncPlan,
  type TransactionDetail,
  type TransactionQuery,
  type TransactionSummary,
  type VersionContent,
  type VersionGraphPage,
} from "@linmu/dsh-session-contracts";

import { decodeJobEventStream } from "./event-stream.js";
import {
  codexProjectMappingConfigurationSchema, codexProjectMappingUpdateSchema,
  type CodexProjectMappingConfiguration, type CodexProjectMappingUpdate,
  integrationDirectorySchema, workspaceSyncConfigurationSchema, integrationActionRequestSchema, workspaceSyncUpdateSchema,
  type IntegrationDirectory, type IntegrationAction, type WorkspaceSyncConfiguration, type WorkspaceSyncUpdate,
} from "@linmu/dsh-session-contracts";

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

  async listIntegrations(signal?: AbortSignal): Promise<IntegrationDirectory> {
    return (await this.request("/v1/integrations", {}, z.strictObject({ directory: integrationDirectorySchema }), signal)).directory;
  }

  async integrationAction(targetId: string, action: IntegrationAction, signal?: AbortSignal): Promise<IntegrationDirectory> {
    const input = integrationActionRequestSchema.parse({ targetId, action });
    return (await this.request("/v1/integrations/actions", this.jsonPost(input), z.strictObject({ directory: integrationDirectorySchema }), signal)).directory;
  }

  async getCodexProjectMapping(signal?: AbortSignal): Promise<CodexProjectMappingConfiguration> {
    return (await this.request("/v1/codex-project-mapping", {}, z.strictObject({ configuration: codexProjectMappingConfigurationSchema }), signal)).configuration;
  }

  async saveCodexProjectMapping(input: CodexProjectMappingUpdate, signal?: AbortSignal): Promise<CodexProjectMappingConfiguration> {
    return (await this.request("/v1/codex-project-mapping", this.jsonPatch(codexProjectMappingUpdateSchema.parse(input)), z.strictObject({ configuration: codexProjectMappingConfigurationSchema }), signal)).configuration;
  }

  async getWorkspaceSync(signal?: AbortSignal): Promise<WorkspaceSyncConfiguration> {
    return (await this.request("/v1/workspace-sync", {}, z.strictObject({ configuration: workspaceSyncConfigurationSchema }), signal)).configuration;
  }

  async saveWorkspaceSync(input: WorkspaceSyncUpdate, signal?: AbortSignal): Promise<WorkspaceSyncConfiguration> {
    return (await this.request("/v1/workspace-sync", this.jsonPatch(workspaceSyncUpdateSchema.parse(input)), z.strictObject({ configuration: workspaceSyncConfigurationSchema }), signal)).configuration;
  }

  async listSessions(query: SessionQuery = {}, signal?: AbortSignal): Promise<Page<SessionSummary>> {
    const search = new URLSearchParams();
    if (query.cursor !== undefined) search.set("cursor", query.cursor);
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    if (query.platform !== undefined) search.set("platform", query.platform);
    if (query.status !== undefined) search.set("status", query.status);
    if (query.workspaceId !== undefined) search.set("workspace", query.workspaceId ?? "__unclassified__");
    const value = await this.request(`/v1/sessions${search.size === 0 ? "" : `?${search}`}`, {}, z.strictObject({ page: pageSchema(sessionSummarySchema) }), signal);
    return value.page as unknown as Page<SessionSummary>;
  }

  async listWorkspaces(signal?: AbortSignal): Promise<readonly WorkspaceSummary[]> {
    const value = await this.request(
      "/v1/workspaces",
      {},
      z.strictObject({ workspaces: z.array(workspaceSummarySchema) }),
      signal,
    );
    return value.workspaces as readonly WorkspaceSummary[];
  }

  async listCanonicalWorkspaces(signal?: AbortSignal): Promise<CanonicalWorkspaceDirectory> {
    return (await this.request(
      "/v1/canonical/workspaces",
      {},
      canonicalWorkspaceDirectoryResponseSchema,
      signal,
    )).directory as unknown as CanonicalWorkspaceDirectory;
  }

  async listCanonicalProjects(signal?: AbortSignal): Promise<CanonicalProjectDirectory> {
    return (await this.request(
      "/v1/canonical/projects",
      {},
      canonicalProjectDirectoryResponseSchema,
      signal,
    )).directory as unknown as CanonicalProjectDirectory;
  }

  async getCanonicalSession(id: string, signal?: AbortSignal): Promise<CanonicalDashboardSessionDetail> {
    return (await this.request(
      `/v1/canonical/sessions/${encodeURIComponent(id)}`,
      {},
      canonicalDashboardSessionResponseSchema,
      signal,
    )).session as unknown as CanonicalDashboardSessionDetail;
  }

  async updateCanonicalSession(id: string, patch: CanonicalSessionMaintenancePatch, signal?: AbortSignal): Promise<CanonicalDashboardSessionDetail> {
    const response = await this.request(
      `/v1/canonical/sessions/${encodeURIComponent(id)}`,
      this.jsonPatch(patch),
      z.custom<{ readonly session: CanonicalDashboardSessionDetail }>(),
      signal,
    );
    return response.session;
  }

  async deleteCanonicalSession(id: string, signal?: AbortSignal): Promise<CanonicalSessionDeleteResult> {
    const response = await this.request(
      `/v1/canonical/sessions/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      z.custom<{ readonly deletion: CanonicalSessionDeleteResult }>(),
      signal,
    );
    return response.deletion;
  }

  async restoreCanonicalSession(id: string, signal?: AbortSignal): Promise<CanonicalSessionRestoreResult> {
    const response = await this.request(
      `/v1/canonical/sessions/${encodeURIComponent(id)}/restore`,
      this.jsonPost({}),
      z.custom<{ readonly restoration: CanonicalSessionRestoreResult }>(),
      signal,
    );
    return response.restoration;
  }

  async listRecentlyDeleted(signal?: AbortSignal): Promise<readonly RecentlyDeletedSession[]> {
    return (await this.request("/v1/canonical/recently-deleted", {}, z.custom<{ readonly sessions: readonly RecentlyDeletedSession[] }>(), signal)).sessions;
  }

  async deleteCanonicalWorkspace(id: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/v1/canonical/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" }, z.strictObject({ deleted: z.literal(true) }), signal);
  }

  async listProjectionRuns(signal?: AbortSignal): Promise<readonly RunCenterItem[]> {
    return (await this.request("/v1/canonical/run-center", {}, z.custom<{ readonly runs: readonly RunCenterItem[] }>(), signal)).runs;
  }

  async listCanonicalAdapters(signal?: AbortSignal): Promise<readonly AdapterDashboardRecord[]> {
    return (await this.request("/v1/canonical/adapters", {}, z.custom<{ readonly adapters: readonly AdapterDashboardRecord[] }>(), signal)).adapters;
  }

  async selectExperimentalAdapter(instanceId: string, adapterId: string, signal?: AbortSignal): Promise<AdapterExperimentalSelectionResponse["selection"]> {
    return (await this.request(
      "/v1/canonical/adapters/select",
      this.jsonPost({ instanceId, adapterId }),
      z.custom<AdapterExperimentalSelectionResponse>(),
      signal,
    )).selection;
  }

  async getGraph(id: string, cursor?: string, signal?: AbortSignal): Promise<VersionGraphPage> {
    const suffix = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    return (await this.request(`/v1/sessions/${encodeURIComponent(id)}/graph${suffix}`, {}, versionGraphResponseSchema, signal)).graph as unknown as VersionGraphPage;
  }

  async overview(signal?: AbortSignal): Promise<DashboardOverview> {
    return (await this.request("/v1/overview", {}, overviewResponseSchema, signal)).overview as DashboardOverview;
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

  async getCheckpointRestoreCapability(checkpointId: string, signal?: AbortSignal): Promise<CheckpointRestoreCapability> {
    return (await this.request(
      `/v1/checkpoints/${encodeURIComponent(checkpointId)}/restore-capability`,
      {},
      checkpointRestoreCapabilityResponseSchema,
      signal,
    )).capability;
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

  async listCodexImports(signal?: AbortSignal): Promise<readonly JobSummary[]> {
    return await this.request("/v1/jobs?kind=codex-import&limit=20", {}, jobListResponseSchema, signal) as readonly JobSummary[];
  }

  async previewRetention(signal?: AbortSignal): Promise<RetentionPreviewPlan> {
    return (await this.request("/v1/retention/preview", this.jsonPost({}), z.custom<{ plan: RetentionPreviewPlan }>(), signal)).plan;
  }

  async getRetentionRegistry(signal?: AbortSignal): Promise<RetentionRegistry> {
    return (await this.request("/v1/retention/registry", {}, z.custom<{ registry: RetentionRegistry }>(), signal)).registry;
  }

  async discoverRetention(signal?: AbortSignal): Promise<RetentionDiscoveryResult> {
    return (await this.request("/v1/retention/discover", this.jsonPost({}), z.custom<{ discovery: RetentionDiscoveryResult }>(), signal)).discovery;
  }

  async listRetentionBatches(signal?: AbortSignal): Promise<readonly RetentionBatch[]> {
    return (await this.request("/v1/retention/batches", {}, z.custom<{ batches: readonly RetentionBatch[] }>(), signal)).batches;
  }

  async executeRetention(planId: string, signal?: AbortSignal): Promise<RetentionBatch> {
    return (await this.request("/v1/retention/execute", this.jsonPost({ planId }), z.custom<{ batch: RetentionBatch }>(), signal)).batch;
  }

  async restoreRetention(batchId: string, signal?: AbortSignal): Promise<RetentionBatch> {
    return (await this.request("/v1/retention/restore", this.jsonPost({ batchId }), z.custom<{ batch: RetentionBatch }>(), signal)).batch;
  }

  async purgeRetention(batchId: string, signal?: AbortSignal): Promise<RetentionBatch> {
    return (await this.request("/v1/retention/purge", this.jsonPost({ batchId }), z.custom<{ batch: RetentionBatch }>(), signal)).batch;
  }

  async verifyRetention(resourceId: string, signal?: AbortSignal): Promise<RetentionResource> {
    return (await this.request("/v1/retention/verify", this.jsonPost({ resourceId }), z.custom<{ resource: RetentionResource }>(), signal)).resource;
  }

  async registerRetentionRoot(input: z.input<typeof retentionRootRegistrationSchema>, signal?: AbortSignal): Promise<RetentionRoot> {
    return (await this.request("/v1/retention/roots", this.jsonPost(input), z.custom<{ root: RetentionRoot }>(), signal)).root;
  }

  async registerRetentionSource(input: z.input<typeof retentionSourceRegistrationSchema>, signal?: AbortSignal): Promise<RetentionSource> {
    return (await this.request("/v1/retention/sources", this.jsonPost(input), z.custom<{ source: RetentionSource }>(), signal)).source;
  }

  async registerFlatRetentionCandidate(sourceId: string, signal?: AbortSignal): Promise<RetentionResource> {
    return (await this.request("/v1/retention/flat-candidates", this.jsonPost({ sourceId }), z.custom<{ resource: RetentionResource }>(), signal)).resource;
  }

  async importCodex(input: CodexImportRequest, signal?: AbortSignal): Promise<JobRef> {
    return (await this.request("/v1/jobs/codex-import", this.jsonPost(input), jobAcceptedResponseSchema, signal)).job;
  }

  async cancelCodexImport(id: string, signal?: AbortSignal): Promise<JobRef> {
    return (await this.request(`/v1/jobs/${encodeURIComponent(id)}/cancel`, this.jsonPost({}), jobAcceptedResponseSchema, signal)).job;
  }

  async resumeCodexImport(id: string, signal?: AbortSignal): Promise<JobRef> {
    return (await this.request(`/v1/jobs/${encodeURIComponent(id)}/resume`, this.jsonPost({}), jobAcceptedResponseSchema, signal)).job;
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

  async listExtensionPanels(signal?: AbortSignal): Promise<ExtensionPanel[]> {
    return this.request("/v1/extensions/panels",{},z.custom<ExtensionPanel[]>(),signal);
  }
  async connectExtensions(input: ExtensionConnect): Promise<ExtensionPanel[]> {
    return this.request("/v1/extensions/connect",this.jsonPost(input),z.custom<ExtensionPanel[]>());
  }
  async enableExtension(scope: ExtensionScope, enabled: boolean): Promise<ExtensionPanel[]> {
    return this.request("/v1/extensions/enabled",this.jsonPost({scope,enabled}),z.custom<ExtensionPanel[]>());
  }
  async listExtensionObjects(query: ExtensionList, signal?: AbortSignal): Promise<ExtensionPage> {
    const parameters = new URLSearchParams(Object.entries(query).filter(([,v])=>v!==undefined).map(([k,v]): [string,string]=>[k,String(v)]));
    return this.request(`/v1/extensions/objects?${parameters}`,{},z.custom<ExtensionPage>(),signal);
  }
  async getExtensionObject(scope: ExtensionScope, objectId: string, signal?: AbortSignal): Promise<ExtensionDetail> {
    return this.request(`/v1/extensions/object?${new URLSearchParams({...scope,objectId})}`,{},z.custom<ExtensionDetail>(),signal);
  }
  async writeExtensionObject(input: ExtensionWrite): Promise<ExtensionWriteResult> {
    return this.request("/v1/extensions/write",this.jsonPost(input),z.custom<ExtensionWriteResult>());
  }
  async getExtensionConflict(scope: ExtensionScope, conflictId: string, signal?: AbortSignal): Promise<ExtensionConflict> {
    return this.request(`/v1/extensions/conflict?${new URLSearchParams({...scope,conflictId})}`,{},z.custom<ExtensionConflict>(),signal);
  }
  async resolveExtensionConflict(scope: ExtensionScope, conflictId: string, revision: number, choice: "current" | "incoming"): Promise<ExtensionWriteResult> {
    return this.request("/v1/extensions/resolve",this.jsonPost({scope,conflictId,revision,choice}),z.custom<ExtensionWriteResult>());
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

  protected override async request<T>(path: string, init: RequestInit, schema: ZodType<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await super.request(path, init, schema, signal);
    } catch (error) {
      if (error instanceof Error && /^(?:UNAUTHORIZED|UI_SESSION_FORBIDDEN):/u.test(error.message)) {
        throw new Error("看板连接凭据已失效或不匹配。请从 DSH 的会话维护设置重新打开完整看板。", { cause: error });
      }
      throw error;
    }
  }

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
