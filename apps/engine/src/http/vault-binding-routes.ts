import type { IncomingMessage, ServerResponse } from "node:http";
import type { VaultBindingManager } from "../vault-bindings.js";
export async function routeVaultBindingRequest(request: IncomingMessage, response: ServerResponse, url: URL, manager: VaultBindingManager | undefined): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/vault-bindings/")) return false;
  response.statusCode = 410; response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({error:{code:"BINDING_MOVED",message:"Vault 连接已迁入 DSH Bridge 设置。请从当前实例选择 Vault；Maintenance 不再管理绑定。"}})); return true;
}
