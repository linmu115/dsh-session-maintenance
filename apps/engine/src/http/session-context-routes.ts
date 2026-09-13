import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { sessionContextCaptureSchema,sessionContextReadSchema,sessionContextScopeSchema } from "@linmu/dsh-session-contracts";
import type { SessionMaintenanceEngine } from "../engine.js";
import { readJsonBody } from "./body.js";

export async function routeSessionContext(request: IncomingMessage,response: ServerResponse,url: URL,engine: SessionMaintenanceEngine) {
  if (!url.pathname.startsWith("/v1/session-context/")||request.method!=="POST") return false;
  const body=await readJsonBody(request,80000),operation=url.pathname.slice("/v1/session-context/".length);
  let result:unknown;
  if(operation==="directory") {
    const q=z.strictObject({runId:z.string().min(1).max(256),workspaceId:z.string().max(256).optional(),after:z.string().max(256).optional()}).parse(body);
    result=await engine.sessionContext.directory(q.runId,q.workspaceId,q.after);
  }else if(operation==="capture") result=await engine.runWrite("context-capture",()=>engine.sessionContext.capture(sessionContextCaptureSchema.parse(body)));
  else if(operation==="read") result=await engine.sessionContext.read(sessionContextReadSchema.parse(body));
  else if(operation==="bind") {
    const q=sessionContextScopeSchema.extend({referenceId:z.string().min(1).max(256),targetMessageId:z.string().min(1).max(256).nullable()}).parse(body);
    result=await engine.runWrite("context-bind",()=>engine.sessionContext.bind(q.runId,q.targetNativeSessionId,q.referenceId,q.targetMessageId));
  }else if(operation==="inspect") {
    const q=sessionContextScopeSchema.extend({referenceId:z.string().min(1).max(256)}).parse(body);
    result=await engine.sessionContext.inspect(q.runId,q.targetNativeSessionId,q.referenceId);
  }else return false;
  response.statusCode=200;response.setHeader("content-type","application/json; charset=utf-8");response.end(JSON.stringify(result));return true;
}
