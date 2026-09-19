import type { IncomingMessage, ServerResponse } from "node:http";
import { vaultBindingTargetSchema, vaultBindingActionSchema } from "@linmu/dsh-session-contracts";
import type { VaultBindingManager } from "../vault-bindings.js";
import { readJsonBody } from "./body.js";
export async function routeVaultBindingRequest(request: IncomingMessage, response: ServerResponse, url: URL, manager: VaultBindingManager | undefined): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/vault-bindings/") || !manager) return false;
  let result: unknown;
  if (request.method === "GET" && url.pathname === "/v1/vault-bindings/instances") result = await manager.instances();
  else if (request.method === "GET" && url.pathname === "/v1/vault-bindings/vaults") result = await manager.list(vaultBindingTargetSchema.parse(Object.fromEntries(url.searchParams)));
  else if (request.method === "POST" && ["/v1/vault-bindings/create", "/v1/vault-bindings/unbind"].includes(url.pathname)) {
    const input = (url.pathname.endsWith("/unbind") ? vaultBindingActionSchema.required({vaultId:true,expectedRevision:true}) : vaultBindingActionSchema).parse(await readJsonBody(request));
    const abort = new AbortController(); const close = () => { if (!response.writableEnded) abort.abort(); }; response.once("close", close);
    try { result = await manager.change(input, url.pathname.endsWith("/unbind"), abort.signal); } finally { response.off("close", close); }
  } else return false;
  response.statusCode = 200; response.setHeader("content-type", "application/json; charset=utf-8"); response.end(JSON.stringify(result)); return true;
}
