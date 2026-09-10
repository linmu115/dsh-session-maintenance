import type { Context } from "@deepseek-ai/cordis";
import type { ExtensionConnect, ExtensionScope, ExtensionContent, ExtensionWriteResult, ExtensionDetail, ExtensionPage } from "@linmu/dsh-session-contracts";
import type { EngineConnectionProvider } from "./engine-proxy.js";

export type ConfiguredExtension = ExtensionConnect["plugins"][number];
/** Host-only bridge. Neither bearer tokens nor arbitrary Engine routes reach the browser. */
export class MaintenanceExtensionBridge {
  private readonly scope: {instanceId:string;profileId:string};
  constructor(private readonly connection: EngineConnectionProvider, scope: {instanceId:string;profileId:string},
    private readonly plugins: readonly ConfiguredExtension[], private readonly fetchImpl: typeof fetch = fetch) {
    this.scope={instanceId:scope.instanceId,profileId:scope.profileId};
  }
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const connection = await this.connection.current();
    const response = await this.fetchImpl(`${connection.origin}/v1/extensions/${path}`,{
      method:body===undefined?"GET":"POST",headers:{authorization:`Bearer ${connection.token}`,"content-type":"application/json"},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Maintenance extension request failed (${response.status}); local edits must be retained until acknowledged`);
    return await response.json() as T;
  }
  private configured(namespace: string) {
    const plugin=this.plugins.find(p=>p.namespace===namespace);
    if(!plugin)throw new Error("Extension is not configured on this DSH instance/profile");
    return plugin;
  }
  async connect(): Promise<void> { await this.request("connect",{...this.scope,plugins:this.plugins}); }
  async get(namespace: string, objectId: string): Promise<ExtensionDetail> {
    this.configured(namespace);return this.request(`object?${new URLSearchParams({...this.scope,namespace,objectId})}`);
  }
  async list(namespace: string, after?: string): Promise<ExtensionPage> {
    this.configured(namespace);return this.request(`objects?${new URLSearchParams({...this.scope,namespace,limit:"30",...(after?{after}:{})})}`);
  }
  async save(namespace:string,objectId:string,expectedRevision:number,content:ExtensionContent,deleted=false):Promise<ExtensionWriteResult> {
    const plugin=this.configured(namespace);
    const scope:ExtensionScope={...this.scope,namespace};
    return this.request("write",{scope,objectId,writerId:plugin.writerId,expectedRevision,content,deleted});
  }
}
export async function registerMaintenanceExtensionData(ctx:Context,bridge:MaintenanceExtensionBridge):Promise<void> {
  // Optional host capability: old isolated/native-only consumers need no new peer
  // at module import time. Cordis is resolved only when this capability is used.
  const {Service}=await import("@deepseek-ai/cordis");
  class MaintenanceExtensionData extends Service {
    readonly bridge=bridge;
    constructor() { super(ctx,"maintenanceExtensionData"); }
  }
  new MaintenanceExtensionData();
}
declare module "@deepseek-ai/cordis" { interface Context { maintenanceExtensionData: {readonly bridge:MaintenanceExtensionBridge} } }
