import {describe,it,expect,vi} from "vitest";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {parse} from "yaml";
vi.mock("../src/integrations/runtime-binding.js",()=>({resolveRuntimeIntegration:async()=>({adapterId:"dsh-0.1.5",packageVersions:{},runtimeCapabilities:[],coreBinding:{path:"synthetic-receipt",sha256:"a".repeat(64)}})}));
import {MaintenanceExternalLifecycleProvider} from "../src/external-lifecycle-provider.js";
describe("RC2 provider resource ownership",()=>{
 it("binds session and attachment services to the same Broker space and keeps attested receipt variables",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dsh-provider-resource-fixture-"));try{
   const persistenceRoot=join(root,"native-spaces","c".repeat(64),"sessions"),controlRoot=join(root,"control");
   const provider=new MaintenanceExternalLifecycleProvider(root,{connection:async()=>({origin:"http://127.0.0.1:12345",token:"synthetic"}),randomId:()=>"abcdefghijklmnop0123456789",fetch:async()=>new Response(JSON.stringify({run:{schemaVersion:1,runId:"synthetic-run",leaseId:"synthetic-lease",adapterId:"dsh-0.1.5",persistenceRoot,controlRoot,temporaryPersistenceRootId:"synthetic-root",runtimeClientId:"plugin-abcdefghijklmnop0123456789",state:"preparing"}}),{status:201,headers:{"content-type":"application/json"}})});
   const response=await provider.handle({schemaVersion:1,phase:"prepare",instanceId:"synthetic-instance",profileId:"web",runtimeVersion:"0.1.5-rc.2",web:true});
   if(!("enabled" in response)||!response.enabled||!response.launch)throw new Error("Preparation refused");
   expect(parse(await readFile(response.launch.launcherArgs![1]!,"utf8"))).toEqual([{id:"session-persistence-jsonl",config:{root:persistenceRoot}},{id:"attachment-local",config:{dshHome:dirname(persistenceRoot)}}]);
   expect(response.launch.env.DSH_SESSION_MAINTENANCE_CORE_RECEIPT).toBe("synthetic-receipt");
   expect(response.launch.env.DSH_SESSION_MAINTENANCE_CORE_RECEIPT_SHA256).toBe("a".repeat(64));
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
