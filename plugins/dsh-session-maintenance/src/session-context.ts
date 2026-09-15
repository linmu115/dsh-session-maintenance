import type { Context } from "@deepseek-ai/cordis";
import type { SessionContextCapture,SessionContextRead,SessionContextRecord,SessionContextDirectory,SessionContextPage,SessionContextDescription,SessionContextReferenceStatus } from "@linmu/dsh-session-contracts";
import type { EngineConnectionProvider } from "./engine-proxy.js";

/** A host-only, instance-bound Interface; callers never choose the run or receive credentials. */
export class MaintenanceSessionContext {
  readonly protocolVersion=1;
  constructor(private readonly connection:EngineConnectionProvider,private readonly runId:string,
    private readonly flush:(nativeSessionId:string)=>Promise<unknown>){}
  private async request<T>(operation:string,input:object):Promise<T>{
    const c=await this.connection.current();
    const response=await fetch(`${c.origin}/v1/session-context/${operation}`,{method:"POST",headers:{authorization:`Bearer ${c.token}`,"content-type":"application/json"},
      body:JSON.stringify({...input,runId:this.runId}),signal:AbortSignal.timeout(30000)});
    const result=await response.json();if(!response.ok)throw new Error((result as {error?:{message?:string}}).error?.message??"Maintenance 上游引用暂不可用");
    return result as T;
  }
  directory(workspaceId?:string,after?:string){return this.request<SessionContextDirectory>("directory",{workspaceId,after});}
  async capture(input:Omit<SessionContextCapture,"runId">){
    await this.flush(input.sourceNativeSessionId);await this.flush(input.targetNativeSessionId);
    return this.request<SessionContextRecord>("capture",input);
  }
  inspect(targetNativeSessionId:string,referenceId:string){return this.request<SessionContextRecord>("inspect",{targetNativeSessionId,referenceId});}
  status(targetNativeSessionId:string,referenceId:string){return this.request<SessionContextReferenceStatus>("status",{targetNativeSessionId,referenceId});}
  describe(targetNativeSessionId:string,referenceId:string){return this.request<SessionContextDescription>("describe",{targetNativeSessionId,referenceId});}
  settleRead(targetNativeSessionId:string,referenceId:string,requestId:string,delivery:'returned'|'failed'){
    return this.request<{recorded:true}>('settle-read',{targetNativeSessionId,referenceId,requestId,delivery});
  }
  bind(targetNativeSessionId:string,referenceId:string,targetMessageId:string|null){return this.request<SessionContextRecord>("bind",{targetNativeSessionId,referenceId,targetMessageId});}
  read(input:Omit<SessionContextRead,"runId">){return this.request<SessionContextPage>("read",input);}
  endExecution(targetNativeSessionId:string,executionId:string){return this.request<{ended:true}>("end-execution",{targetNativeSessionId,executionId});}
}
declare module "@deepseek-ai/cordis" { interface Context {maintenanceSessionContext:MaintenanceSessionContext} }
export function registerSessionContext(ctx:Context,value:MaintenanceSessionContext){ctx.provide("maintenanceSessionContext",value);}
