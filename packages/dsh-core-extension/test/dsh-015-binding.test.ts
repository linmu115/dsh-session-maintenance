import { Context } from "@deepseek-ai/cordis";
import { createRequire } from "node:module";
import {describe,it,expect} from "vitest";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
import {createDsh015CoreHostBinding,dsh015CoreContractFingerprint,LockedDsh015CoreExtension} from "../src/index.js";
import {v3NativeSessionCodec,v3NativeArtifactPath} from "../../adapter-dsh-0-1-5/src/index.js";
const hash=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
const nodePin={path:process.execPath,sha256:hash(await readFile(process.execPath))};
async function fixture(officialStorage=false){
 const root=await mkdtemp(join(tmpdir(),"synthetic-v3-binding-")),key=hash(JSON.stringify(["synthetic-instance","web","main","dsh-0.1.5","dsh-0.1.5-v3-jsonl-zstd-v1"])),nativeRoot=join(root,"native-spaces",key,"sessions");await mkdir(nativeRoot,{recursive:true});await writeFile(join(dirname(nativeRoot),"space.json"),JSON.stringify({schemaVersion:1,key,owner:"synthetic-run",state:"ready",files:{}}));
 const implementations:Record<string,string>={
  session:`export default class {store=new Map();get(id){return this.store.get(id)}prepare(id){return {id}}enter(session){this.store.set(session.id,session);return ()=>this.store.delete(session.id)}}`,
  sessionPersistence:`export function validateStoredEvents(header,events){if(header.version!==3)throw new Error('bad header');return events}`,
  jsonlPersistence:`export default class {constructor(root){this.config={root};this.headers=new Map;this.logs=new Map;this.owners=new Set;this.count=0} async stat(id){const header=this.headers.get(id);return header?{header,revision:this.count}:undefined}async list(){return [...this.headers.values()].map(header=>({header,revision:this.count}))}async create(header){this.headers.set(header.id,header);this.logs.set(header.id,[]);return this.open(header.id,'write')}async open(id,access){if(access==='write'&&this.owners.has(id))throw new Error('writer conflict');if(access==='write')this.owners.add(id);const self=this;return {id,header:this.headers.get(id),inheritedEventCount:0,access,read:async()=>({events:self.logs.get(id)}),append:async events=>{self.logs.get(id).push(...events);self.count++},flush:async()=>{},close:async()=>{if(access==='write')self.owners.delete(id)}}}}`,
  workspace:`export default class {state={initialized:true,workspaceIds:[],archivedSessionIds:[]};list(){return []}get(){return undefined}get archivedSessionIds(){return this.state.archivedSessionIds}async archiveSession(id){this.state.archivedSessionIds.push(id)}async enqueueOperation(action){return action()}async setState(state){this.state=state}}`,
  projectionCache:`export const projectionCacheDomainSpec={name:'session_projcache'};export default class {}`,
  sessionQuery:`export default class {async readSession(){return null}}`,formatCatalog:`export const sessionFormatCatalog={currentVersion:3}`};
 if(officialStorage){const require=createRequire(import.meta.url),entry=require.resolve("@deepseek-ai/dsh-session-persistence-jsonl"),peer=createRequire(entry).resolve("@deepseek-ai/dsh-session-persistence");implementations.jsonlPersistence=`export {default} from ${JSON.stringify(pathToFileURL(entry).href)};`;implementations.sessionPersistence=`export {validateStoredEvents} from ${JSON.stringify(pathToFileURL(peer).href)};`;}
 const names:Record<string,string>={session:"session",sessionPersistence:"session-persistence",jsonlPersistence:"session-persistence-jsonl",workspace:"workspace",projectionCache:"session-projection-cache",sessionQuery:"session-query",formatCatalog:"session-format-catalog"},packages:any={},implementationHashes:any={},packageVersions:any={},loaded:any={};
 for(const [role,code]of Object.entries(implementations)){const name=`@deepseek-ai/dsh-${names[role]}`,dir=join(root,"node_modules",name);await mkdir(dir,{recursive:true});const manifestPath=join(dir,"package.json"),entryPath=join(dir,"index.js"),manifest=JSON.stringify({name,version:"0.1.5-rc.2",type:"module",main:"index.js"});await writeFile(manifestPath,manifest);await writeFile(entryPath,code);packages[name]={manifestPath,entryPath,manifestSha256:hash(manifest),entrySha256:hash(code)};implementationHashes[role]=`sha256:${hash(code)}`;packageVersions[name]="0.1.5-rc.2";loaded[role]=await import(pathToFileURL(entryPath).href);}
 const observation={platformVersion:"0.1.5-rc.2",sessionFormatVersion:3,packageVersions,implementationHashes,methods:{sessionPersistence:["stat","list","open","create"],sessionHandle:["read","append","flush","close"],session:["validateStoredEvents"]}};
 const receipt={schemaVersion:1,node:nodePin,observation,expectedContractFingerprint:dsh015CoreContractFingerprint(observation),packages,materialization:{sourceHash:"fixture",artifactHash:"fixture"}},receiptPath=join(root,"receipt.json"),bytes=JSON.stringify(receipt);await writeFile(receiptPath,bytes);const records=new Map();
 const officialContext=officialStorage?new Context():undefined;
 if(officialContext)await officialContext.plugin(loaded.jsonlPersistence.default,{root:nativeRoot,compression:"zstd"});
 const runtime={sessions:new loaded.session.default(),sessionPersistence:officialContext?.sessionPersistence??new loaded.jsonlPersistence.default(nativeRoot),workspaceRegistry:new loaded.workspace.default(),sessionProjectionCache:new loaded.projectionCache.default(),sessionQuery:new loaded.sessionQuery.default(),storageDomain:{open:async()=>({table:(name:string)=>{if(name!=="sessions")throw new Error("wrong table");return {get:(id:string)=>records.get(id),put:async(id:string,v:unknown)=>{records.set(id,v)},delete:async(id:string)=>{records.delete(id)}}},close:async()=>{}})}};
 const input={runtime,importAnchor:join(root,"plugin.js"),instanceId:"synthetic-instance",profileId:"web",runId:"synthetic-run",receiptPath,receiptSha256:hash(bytes)};
 return {root,nativeRoot,input,runtime,records,officialContext};
}
describe("concrete RC2 Core binding (synthetic modules)",()=>{
 it("binds attested service instances, blocks Agent entry and writer acquisition until the offline transaction releases",async()=>{const f=await fixture();let binding:any;try{binding=await createDsh015CoreHostBinding(f.input);const header={version:3,id:"synthetic",createdAt:0,delegationDepth:0,isSeeded:false};await binding.host.withOfflineSession("synthetic",async()=>{await binding.host.createSessionWithEvents(header,[],0);expect(f.runtime.sessionPersistence.owners.has("synthetic")).toBe(true)});expect(f.runtime.sessionPersistence.owners.size).toBe(0);
 let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r}),gate=new Promise<void>(r=>{release=r});const transaction=binding.host.withOfflineSession("synthetic",async()=>{entered();await gate});await ready;expect(()=>f.runtime.sessions.prepare("synthetic")).toThrow("DSH_BUSY");await expect(f.runtime.sessionPersistence.open("synthetic","write")).rejects.toThrow("DSH_BUSY");release();await transaction;const writer=await f.runtime.sessionPersistence.open("synthetic","write");await expect(binding.host.withOfflineSession("synthetic",async()=>{})).rejects.toThrow("DSH_BUSY");await writer.close();expect((await binding.host.observeContract()).platformVersion).toBe("0.1.5-rc.2");await writeFile(f.input.receiptPath,"{}");await expect(binding.host.observeContract()).rejects.toThrow("Untrusted");}finally{await binding?.dispose();await rm(f.root,{recursive:true,force:true})}});
 it("refuses an old service object even with a valid receipt and never installs guards on failure",async()=>{const f=await fixture();try{f.runtime.sessions={get(){},prepare(){},enter(){}} as any;const before=f.runtime.sessionPersistence.open;await expect(createDsh015CoreHostBinding(f.input)).rejects.toThrow("attested module");expect(f.runtime.sessionPersistence.open).toBe(before);}finally{await rm(f.root,{recursive:true,force:true})}});
});

it("restores and removes managed artifacts under the real released JSONL handle lock", async()=>{
 const f=await fixture(true);let binding:Awaited<ReturnType<typeof createDsh015CoreHostBinding>>|undefined;
 try {
  binding=await createDsh015CoreHostBinding(f.input);
  const header={version:3 as const,id:"official-cold",createdAt:0,delegationDepth:0,isSeeded:false};
  await binding.host.withOfflineSession(header.id,()=>binding!.host.createSessionWithEvents(header,[],0));
  const before=await binding.host.captureSession(header.id);expect(before.exists).toBe(true);
  const detail={type:"dsh-runtime/detail",seq:0,time:1,data:{id:"fixture",items:[]},ignorable:true};
  await binding.host.withOfflineSession(header.id,async()=>{await binding!.host.appendEvents(header.id,[detail]);expect((await binding!.host.captureSession(header.id) as any).events).toHaveLength(1);});
  await binding.host.withOfflineSession(header.id,()=>binding!.host.restoreSession({sessionId:header.id,...before}));
  expect(await binding.host.captureSession(header.id)).toEqual(before);
  // A fresh official writer must see the restored prefix after the Maintenance owner closes.
  const writer=await f.runtime.sessionPersistence.open(header.id,"write");try{expect((await writer.read()).events).toEqual([]);await writer.append([detail]);await writer.flush();}finally{await writer.close()}
  await binding.host.withOfflineSession(header.id,()=>binding!.host.restoreSession({sessionId:header.id,exists:false}));
  expect(await f.runtime.sessionPersistence.stat(header.id)).toBeUndefined();
 }finally{await binding?.dispose();await f.officialContext?.fiber.dispose();await rm(f.root,{recursive:true,force:true})}
});
