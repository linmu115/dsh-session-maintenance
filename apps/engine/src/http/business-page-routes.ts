import type { IncomingMessage, ServerResponse } from "node:http";
import { businessPageActionRequestSchema, businessPageOwnerSchema, businessPageActionAckSchema, businessPageRegistrationSchema } from "@linmu/dsh-session-contracts";
import { z } from "zod";
import type { BusinessPageRegistry } from "../business-pages.js";
import { IntegrationError } from "../integrations/bindings.js";
import { readJsonBody } from "./body.js";
/** Common origin/session/CSRF checks precede this route. Host mutation routes additionally require bearer authentication. */
export async function routeBusinessPageRequest(request: IncomingMessage, response: ServerResponse, url: URL,
  input: { businessPages: BusinessPageRegistry | undefined; hostAuthenticated: boolean }): Promise<boolean> {
  const prefix = "/v1/business-pages";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
  const operation = url.pathname.slice(prefix.length);
  const hostOperations = ["/register", "/unregister", "/heartbeat", "/poll", "/ack"];
  if (!(request.method === "GET" && operation === "" || request.method === "POST" && [...hostOperations, "/actions", "/receipt"].includes(operation))) return false;
  if (hostOperations.includes(operation) && !input.hostAuthenticated) throw new IntegrationError("BUSINESS_PAGE_HOST_ONLY", "信息页提供方接口只允许受信宿主调用。", 403);
  const registry = input.businessPages;
  if (!registry) throw new IntegrationError("BUSINESS_PAGE_UNAVAILABLE", "公共业务信息页暂未启用。", 503);
  const send = (value: unknown) => { response.statusCode = 200; response.setHeader("content-type", "application/json; charset=utf-8"); response.end(JSON.stringify(value)); };
  if (request.method === "GET") { send(registry.list()); return true; }
  const body = await readJsonBody(request, 256 * 1024);
  if (operation === "/register") send(await registry.register(businessPageRegistrationSchema.parse(body)));
  else if (operation === "/heartbeat") { await registry.heartbeat(businessPageOwnerSchema.parse(body)); send({ renewed: true }); }
  else if (operation === "/unregister") { await registry.unregister(businessPageOwnerSchema.parse(body)); send({ released: true }); }
  else if (operation === "/poll") send(await registry.poll(businessPageOwnerSchema.parse(body)));
  else if (operation === "/ack") send(await registry.acknowledge(businessPageActionAckSchema.parse(body)));
  else if (operation === "/actions") send(await registry.enqueue(businessPageActionRequestSchema.parse(body)));
  else { const query = z.strictObject({ owner: businessPageOwnerSchema, operationId: z.uuid() }).parse(body); send(registry.receipt(query.owner, query.operationId)); }
  return true;
}
