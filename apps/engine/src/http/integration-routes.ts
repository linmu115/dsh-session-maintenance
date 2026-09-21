import type { IncomingMessage, ServerResponse } from "node:http";
import { integrationActionRequestSchema, workspaceSyncUpdateSchema, standaloneInstanceSchema, selectInstanceFolderResponseSchema,
  instanceTakeoverRequestSchema, instanceTakeoverResponseSchema, takeoverClaimRequestSchema, takeoverQuerySchema,
  instanceSyncDecisionResponseSchema, instanceSyncRequestCreateSchema, workspaceJoinRequestSchema } from "@linmu/dsh-session-contracts";
import type { InstanceIntegrationService } from "../integrations/service.js";
import type { WorkspaceSyncPolicyService } from "../integrations/sync-policy.js";
import { IntegrationError } from "../integrations/bindings.js";
import { codexProjectMappingUpdateSchema } from "@linmu/dsh-session-contracts";
import type { CodexProjectMappingService } from "../codex-project-mapping.js";
import { readJsonBody } from "./body.js";

/** Called only after the common bearer/session/CSRF and exact-origin guards. */
export async function routeIntegrationRequest(request: IncomingMessage, response: ServerResponse, url: URL, input: {
  integrations: InstanceIntegrationService | undefined; workspaceSync: WorkspaceSyncPolicyService | undefined;
  codexProjectMapping?: CodexProjectMappingService | undefined;
}): Promise<boolean> {
  const send = (value: unknown) => { response.statusCode = 200; response.setHeader("content-type", "application/json; charset=utf-8"); response.end(`${JSON.stringify(value)}\n`); };
  if (url.pathname === '/v1/integrations/instance-folder' && request.method === 'POST') {
    if (!input.integrations) throw new IntegrationError('INTEGRATION_UNAVAILABLE', '接入管理尚未就绪。', 503);
    // The dialog is the only effect; the answer is a described folder the
    // operator still has to confirm, so this route never writes a binding. A
    // caller that goes away closes its own dialog instead of leaving it open.
    const lifetime = new AbortController();
    const disconnect = () => lifetime.abort(new Error('client disconnected'));
    request.once('close', disconnect);
    try {
      send(selectInstanceFolderResponseSchema.parse(await input.integrations.selectInstanceFolder(lifetime.signal)));
    } finally { request.off('close', disconnect); }
    return true;
  }
  if (url.pathname === '/v1/integrations/takeover' && request.method === 'POST') {
    if (!input.integrations) throw new IntegrationError('INTEGRATION_UNAVAILABLE', '接入管理尚未就绪。', 503);
    const body = instanceTakeoverRequestSchema.parse(await readJsonBody(request));
    // `detect` is read-only: it answers whether the selected folder's instance is
    // running now. `takeover` is the only mode that prepares an Engine run, and
    // it refuses unless the instance proved it is that running instance.
    if (body.mode === 'detect') {
      const inspected = await input.integrations.inspectInstanceTakeover(body.targetId);
      send(instanceTakeoverResponseSchema.parse({ lease: inspected.lease, handoff: null }));
      return true;
    }
    const taken = await input.integrations.takeoverInstance(body.targetId);
    send(instanceTakeoverResponseSchema.parse({ lease: taken.lease,
      handoff: taken.handoff === null ? null : { ticketId: taken.handoff.ticketId, runId: taken.handoff.runId,
        claimPath: `/v1/integrations/takeover/${encodeURIComponent(taken.handoff.ticketId)}/claim` } }));
    return true;
  }
  const takeoverClaim = /^\/v1\/integrations\/takeover\/([^/]+)\/claim$/u.exec(url.pathname);
  if (takeoverClaim !== null && request.method === 'POST') {
    if (!input.integrations) throw new IntegrationError('INTEGRATION_UNAVAILABLE', '接入管理尚未就绪。', 503);
    const body = takeoverClaimRequestSchema.parse(await readJsonBody(request));
    const ticketId = decodeURIComponent(takeoverClaim[1]!);
    if (body.ticketId !== ticketId) throw new IntegrationError('INSTANCE_TAKEOVER_TICKET_MISMATCH', '接管票据与请求不一致。', 400);
    send({ handoff: await input.integrations.claimTakeoverHandoff(body) });
    return true;
  }
  if (url.pathname === '/v1/integrations/takeovers' && request.method === 'GET') {
    if (!input.integrations) throw new IntegrationError('INTEGRATION_UNAVAILABLE', '接入管理尚未就绪。', 503);
    const query = takeoverQuerySchema.parse({ instanceId: url.searchParams.get('instanceId'),
      profileId: url.searchParams.get('profileId') });
    // The instance polls this to learn that the Engine prepared a run for it; an
    // empty list is the normal answer while nothing is waiting for it.
    send({ takeovers: (await input.integrations.listPendingTakeovers(query.instanceId, query.profileId))
      .map(handoff => ({ ticketId: handoff.ticketId, runId: handoff.runId, createdAt: handoff.createdAt,
        claimPath: `/v1/integrations/takeover/${encodeURIComponent(handoff.ticketId)}/claim` })) });
    return true;
  }
  if (url.pathname === '/v1/integrations/sync-requests' && request.method === 'POST') {
    if (!input.integrations) throw new IntegrationError('INTEGRATION_UNAVAILABLE', '接入管理尚未就绪。', 503);
    const body = instanceSyncRequestCreateSchema.parse(await readJsonBody(request));
    // The Engine states what it wants synchronised and waits for the user's
    // answer; nothing is written into the instance by this call.
    send({ request: await input.integrations.requestInstanceSync(body.targetId, body.summary) });
    return true;
  }
  if (url.pathname === '/v1/integrations/sync-requests' && request.method === 'GET') {
    if (!input.integrations) throw new IntegrationError('INTEGRATION_UNAVAILABLE', '接入管理尚未就绪。', 503);
    const query = takeoverQuerySchema.parse({ instanceId: url.searchParams.get('instanceId'),
      profileId: url.searchParams.get('profileId') });
    // The instance surfaces these to its own user; an empty list is the normal answer.
    send({ requests: (await input.integrations.listPendingInstanceSync(query.instanceId, query.profileId))
      .map(stored => stored.request) });
    return true;
  }
  const syncDecision = /^\/v1\/integrations\/sync-requests\/([^/]+)\/decision$/u.exec(url.pathname);
  if (syncDecision !== null && request.method === 'POST') {
    if (!input.integrations) throw new IntegrationError('INTEGRATION_UNAVAILABLE', '接入管理尚未就绪。', 503);
    const body = instanceSyncDecisionResponseSchema.parse(await readJsonBody(request));
    if (body.requestId !== decodeURIComponent(syncDecision[1]!))
      throw new IntegrationError('INSTANCE_SYNC_DECISION_MISMATCH', '同步决定与请求不一致。', 400);
    send({ decision: await input.integrations.decideInstanceSync(body) });
    return true;
  }
  if (url.pathname === '/v1/instances/workspace-joins' && request.method === 'POST') {
    if (!input.integrations) throw new IntegrationError('INTEGRATION_UNAVAILABLE', '接入管理尚未就绪。', 503);
    // The instance-side workspace entry reaches this through its own Engine proxy;
    // the Engine is the side that maps the workspace into its own storage.
    send({ join: await input.integrations.joinWorkspace(workspaceJoinRequestSchema.parse(await readJsonBody(request))) });
    return true;
  }
  if (url.pathname === '/v1/integrations/standalone' && request.method === 'POST') {
    if (!input.integrations) throw new IntegrationError('INTEGRATION_UNAVAILABLE', '接入管理尚未就绪。', 503);
    send({ directory: await input.integrations.registerStandalone(standaloneInstanceSchema.parse(await readJsonBody(request))) }); return true;
  }
  if (url.pathname === "/v1/codex-project-mapping" && ["GET", "PATCH"].includes(request.method ?? "")) {
    if (input.codexProjectMapping === undefined) throw new IntegrationError("MAPPING_UNAVAILABLE", "此引擎尚未配置 Codex 项目映射。", 503);
    send({ configuration: request.method === "GET" ? await input.codexProjectMapping.get() : await input.codexProjectMapping.save(codexProjectMappingUpdateSchema.parse(await readJsonBody(request))) }); return true;
  }
  if (url.pathname === "/v1/integrations" && request.method === "GET") {
    if (input.integrations === undefined) throw new IntegrationError("INTEGRATION_UNAVAILABLE", "此引擎尚未配置接入管理。", 503);
    send({ directory: await input.integrations.list() }); return true;
  }
  if (url.pathname === "/v1/integrations/actions" && request.method === "POST") {
    if (input.integrations === undefined) throw new IntegrationError("INTEGRATION_UNAVAILABLE", "此引擎尚未配置接入管理。", 503);
    const action = integrationActionRequestSchema.parse(await readJsonBody(request));
    send({ directory: await input.integrations.action(action.targetId, action.action) }); return true;
  }
  if (url.pathname === "/v1/workspace-sync" && ["GET", "PATCH"].includes(request.method ?? "")) {
    if (input.workspaceSync === undefined) throw new IntegrationError("SYNC_CONFIGURATION_UNAVAILABLE", "此引擎尚未配置工作区同步策略。", 503);
    send({ configuration: request.method === "GET" ? await input.workspaceSync.get() : await input.workspaceSync.save(workspaceSyncUpdateSchema.parse(await readJsonBody(request))) }); return true;
  }
  return false;
}
