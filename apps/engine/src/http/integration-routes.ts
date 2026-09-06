import type { IncomingMessage, ServerResponse } from "node:http";
import { integrationActionRequestSchema, workspaceSyncUpdateSchema } from "@linmu/dsh-session-contracts";
import type { InstanceIntegrationService } from "../integrations/service.js";
import type { WorkspaceSyncPolicyService } from "../integrations/sync-policy.js";
import { IntegrationError } from "../integrations/bindings.js";
import { readJsonBody } from "./body.js";

/** Called only after the common bearer/session/CSRF and exact-origin guards. */
export async function routeIntegrationRequest(request: IncomingMessage, response: ServerResponse, url: URL, input: {
  integrations: InstanceIntegrationService | undefined; workspaceSync: WorkspaceSyncPolicyService | undefined;
}): Promise<boolean> {
  const send = (value: unknown) => { response.statusCode = 200; response.setHeader("content-type", "application/json; charset=utf-8"); response.end(`${JSON.stringify(value)}\n`); };
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
