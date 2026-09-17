import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ExtensionDataError, extensionScopeSchema, extensionConnectSchema, extensionWriteSchema, extensionListSchema } from "@linmu/dsh-session-contracts";
import { extensionDirectoryQuerySchema, extensionBusinessPanelQuerySchema, annotationMirrorSyncSchema } from "@linmu/dsh-session-contracts";
import type { SessionMaintenanceEngine } from "../engine.js";
import { readJsonBody } from "./body.js";

/** Common Engine authentication/CSRF guards run before these routes. */
export async function routeExtensionRequest(request: IncomingMessage, response: ServerResponse, url: URL, engine: SessionMaintenanceEngine): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/extensions/")) return false;
  const service = engine.extensions;
  if (!service) throw new ExtensionDataError("EXTENSION_UNAVAILABLE", "扩展数据模块不可用。",503);
  const send = (value: unknown) => { response.statusCode=200; response.setHeader("content-type","application/json; charset=utf-8"); response.end(JSON.stringify(value)); };
  const query = Object.fromEntries(url.searchParams);
  if (request.method === "GET") {
    await engine.runWrite("native-extension-index", () => service.refreshNativeIndexes());
    if (url.pathname === "/v1/extensions/business-panels") {
      const panels = service.businessPanels(extensionBusinessPanelQuerySchema.parse(query));
      send(await Promise.all(panels.map(async panel => ({ ...panel, instanceLabel:
        await engine.integrations?.instanceDisplayName(panel.scope.instanceId, panel.scope.profileId)
        ?? engine.instances.find(instance => instance.id === panel.scope.instanceId)?.displayName ?? panel.instanceLabel })))); return true;
    }
    if (url.pathname === "/v1/extensions/directory") { send(service.directory(extensionDirectoryQuerySchema.parse(query))); return true; }
    if (url.pathname === "/v1/extensions/panels") { send(service.panels()); return true; }
    if (url.pathname === "/v1/extensions/objects") { send(service.list(extensionListSchema.parse(query))); return true; }
    if (url.pathname === "/v1/extensions/object") {
      const q = extensionScopeSchema.extend({ objectId: z.string().min(1).max(256) }).parse(query);
      send(service.get({ instanceId:q.instanceId,profileId:q.profileId,namespace:q.namespace },q.objectId)); return true;
    }
    if (url.pathname === "/v1/extensions/conflict") {
      const q = extensionScopeSchema.extend({ conflictId: z.string().uuid() }).parse(query);
      send(service.conflict({ instanceId:q.instanceId,profileId:q.profileId,namespace:q.namespace },q.conflictId)); return true;
    }
  }
  if (request.method !== "POST") return false;
  if (url.pathname === "/v1/extensions/annotation-sync") {
    const body = annotationMirrorSyncSchema.parse(await readJsonBody(request, 512 * 1024));
    send(await engine.runWrite("annotation-mirror-sync", () => service.syncAnnotation(body, engine))); return true;
  }
  if (url.pathname === "/v1/extensions/connect") {
    const body = extensionConnectSchema.parse(await readJsonBody(request)); send(await engine.runWrite("extension-connect",()=>service.connect(body))); return true;
  }
  if (url.pathname === "/v1/extensions/enabled") {
    const body = z.strictObject({ scope: extensionScopeSchema, enabled:z.boolean() }).parse(await readJsonBody(request));
    send(await engine.runWrite("extension-enable",()=>service.enable(body.scope,body.enabled))); return true;
  }
  if (url.pathname === "/v1/extensions/write") {
    const body = extensionWriteSchema.parse(await readJsonBody(request,600*1024)); send(await engine.runWrite("extension-write",()=>service.write(body))); return true;
  }
  if (url.pathname === "/v1/extensions/resolve") {
    const body = z.strictObject({ scope:extensionScopeSchema,conflictId:z.string().uuid(),revision:z.number().int().positive(),choice:z.enum(["current","incoming"]) }).parse(await readJsonBody(request));
    send(await engine.runWrite("extension-resolve",()=>service.resolve(body.scope,body.conflictId,body.revision,body.choice))); return true;
  }
  return false;
}
