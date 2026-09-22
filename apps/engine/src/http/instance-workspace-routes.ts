import type { IncomingMessage, ServerResponse } from "node:http";
import { instanceWorkspacePolicyUpdateSchema } from "@linmu/dsh-session-contracts";
import type { InstanceWorkspaceService } from "../instance-workspace-service.js";
import { IntegrationError } from "../integrations/bindings.js";
import { readJsonBody } from "./body.js";

/** Mount only AFTER the Engine's common authentication, exact-origin and CSRF checks. */
export async function routeInstanceWorkspaceRequest(request: IncomingMessage, response: ServerResponse, url: URL,
  input: { instanceWorkspace: InstanceWorkspaceService | undefined }): Promise<boolean> {
  const directory = url.pathname === "/v1/instances/workspace-sync" && request.method === "GET";
  const folders = /^\/v1\/instances\/([^/]+)\/workspace-folders$/u.exec(url.pathname);
  const match = /^\/v1\/instances\/([^/]+)\/(workspace-sync|workspace-scope|sessions\/([^/]+)\/availability)$/u.exec(url.pathname);
  if (!directory && folders === null && (!match || !(request.method === "GET" || request.method === "PATCH" && match[2] === "workspace-sync"))) return false;
  if (!input.instanceWorkspace) throw new IntegrationError("INSTANCE_WORKSPACE_UNAVAILABLE", "当前维护引擎尚未提供实例工作区同步范围。", 503);
  const service = input.instanceWorkspace;
  const send = (value: unknown) => { response.statusCode = 200; response.setHeader("content-type", "application/json; charset=utf-8"); response.end(`${JSON.stringify(value)}\n`); };
  if (directory) { send({ directory: await service.listInstances() }); return true; }
  // The instance asks which folders it should own; the Engine answers from its own mapping records,
  // never from a path the instance supplies.
  if (folders !== null) { send({ folders: await service.workspaceFolders(decodeURIComponent(folders[1]!)) }); return true; }
  let instanceId: string, logicalSessionId: string | undefined;
  try { instanceId = decodeURIComponent(match![1]!); logicalSessionId = match![3] === undefined ? undefined : decodeURIComponent(match![3]); }
  catch { throw new IntegrationError("INSTANCE_WORKSPACE_INVALID_PATH", "实例或会话标识编码无效。", 400); }
  const profileId = url.searchParams.get("profileId") ?? "web";
  if (match![2] === "workspace-sync") send({ configuration: request.method === "GET" ? await service.get(instanceId)
    : await service.save(instanceId, instanceWorkspacePolicyUpdateSchema.parse(await readJsonBody(request))) });
  else if (match![2] === "workspace-scope") send({ scope: await service.effectiveScope(instanceId, profileId) });
  else send({ availability: await service.sessionAvailability(instanceId, logicalSessionId!, profileId) });
  return true;
}
