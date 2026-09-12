import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, stat, readFile, realpath, open, rename, unlink, readdir } from "node:fs/promises";
import { basename,dirname,isAbsolute,join,relative,resolve,sep } from "node:path";
import { fileURLToPath,pathToFileURL } from "node:url";
import { canonicalJson } from "@linmu/dsh-session-domain";
import { v3NativeSessionCodec,v3NativeArtifactPath,validateV3Artifact } from "@linmu/dsh-session-adapter-0-1-5";
import { Dsh015CoreHost,type Dsh015MetadataHost,type Dsh015SessionHandle,type Dsh015SessionPersistence } from "./dsh-015-host.js";
import { assessDsh015CoreContract,dsh015CoreContractFingerprint,type Dsh015CoreContractObservation } from "./dsh-015-contract.js";
import { probeBuiltDsh015CoreHost } from "./dsh-015-materialization.js";
import type { DshNativeSessionHeader,DshSessionArtifactSnapshot } from "./types.js";

type ObjectRecord=Record<string,any>;
const object=(value:unknown):ObjectRecord=>{if(value===null||typeof value!=="object"||Array.isArray(value))throw new TypeError("Invalid RC2 binding object");return value as ObjectRecord;};
const sha=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
export interface Dsh015CoreBindingReceipt {
 readonly schemaVersion:1;
 readonly node:{readonly path:string;readonly sha256:string};
 readonly observation:Dsh015CoreContractObservation;
 readonly expectedContractFingerprint:string;
 readonly packages:Readonly<Record<string,{readonly manifestPath:string;readonly entryPath:string;readonly manifestSha256:string;readonly entrySha256:string}>>;
 readonly materialization:{readonly sourceHash:string;readonly artifactHash:string};
}
export interface Dsh015CoreBindingInput {
 readonly runtime:unknown;
 readonly importAnchor:string;
 readonly instanceId:string;
 readonly profileId:string;
 readonly runId:string;
 readonly branchId?:string;
 readonly receiptPath:string;
 readonly receiptSha256:string;
}
const modules={session:"@deepseek-ai/dsh-session",sessionPersistence:"@deepseek-ai/dsh-session-persistence",jsonlPersistence:"@deepseek-ai/dsh-session-persistence-jsonl",workspace:"@deepseek-ai/dsh-workspace",projectionCache:"@deepseek-ai/dsh-session-projection-cache",sessionQuery:"@deepseek-ai/dsh-session-query",formatCatalog:"@deepseek-ai/dsh-session-format-catalog"} as const;
function requireMethods(value:unknown,names:readonly string[]):void{const target=object(value);for(const name of names)if(typeof target[name]!=="function")throw new TypeError(`RC2 required method missing: ${name}`);}
let nodeDigest:{stamp:string;value:string}|undefined;
async function actualNode(){const path=await realpath(process.execPath),before=await stat(path,{bigint:true}),stamp=`${path}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;if(nodeDigest?.stamp!==stamp){const value=sha(await readFile(path)),after=await stat(path,{bigint:true});if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new TypeError("Node executable changed during verification");nodeDigest={stamp,value};}return {path,sha256:nodeDigest.value};}
async function verifyReceipt(input:Dsh015CoreBindingInput){
 const bytes=await readFile(input.receiptPath);if(sha(bytes)!==input.receiptSha256)throw new TypeError("Untrusted RC2 Core receipt");const receipt=JSON.parse(bytes.toString("utf8")) as Dsh015CoreBindingReceipt;
 if(receipt.schemaVersion!==1||assessDsh015CoreContract(receipt.observation,receipt.expectedContractFingerprint).status!=="compatible")throw new TypeError("RC2 Core receipt contract mismatch");
 const node=await actualNode();if(!receipt.node||await realpath(receipt.node.path)!==node.path||receipt.node.sha256!==node.sha256)throw new TypeError("RC2 actual Node differs from the approved receipt");
 const anchor=input.importAnchor.startsWith("file:")?fileURLToPath(input.importAnchor):input.importAnchor;
 const require=createRequire(anchor), loaded:Record<string,ObjectRecord>={};
 for(const [role,name] of Object.entries(modules)){
  const pin=receipt.packages[name];if(!pin||!isAbsolute(pin.entryPath)||!isAbsolute(pin.manifestPath))throw new TypeError(`RC2 Core receipt misses ${name}`);
  const entry=await realpath(require.resolve(name));if(entry!==await realpath(pin.entryPath))throw new TypeError(`RC2 runtime importer resolves another ${name}`);
  const [manifestBytes,entryBytes]=await Promise.all([readFile(pin.manifestPath),readFile(entry)]);const manifest=JSON.parse(manifestBytes.toString("utf8"));
  if(manifest.name!==name||manifest.version!=="0.1.5-rc.2"||sha(manifestBytes)!==pin.manifestSha256||sha(entryBytes)!==pin.entrySha256||receipt.observation.implementationHashes[role]!==`sha256:${pin.entrySha256}`)throw new TypeError(`RC2 resolved artifact drift: ${name}`);
  loaded[role]=object(await import(pathToFileURL(entry).href));
 }
 return {receipt,loaded};
}
/** Real runtime binding for the pinned RC2 backend. No legacy persistence/coordinator facade. */
export async function createDsh015CoreHostBinding(input:Dsh015CoreBindingInput){
 const ctx=object(input.runtime),storage=object(ctx.sessionPersistence),sessions=object(ctx.sessions),workspace=object(ctx.workspaceRegistry);
 const {receipt,loaded}=await verifyReceipt(input);
 requireMethods(storage,["stat","list","open","create"]);requireMethods(sessions,["get","prepare","enter"]);requireMethods(workspace,["list","get","archiveSession"]);requireMethods(ctx.sessionQuery,["readSession"]);requireMethods(ctx.storageDomain,["get"]);
 requireMethods(loaded.sessionPersistence,["validateStoredEvents"]);
 // Exactly two registry primitives lack public unarchive equivalents in fixed RC2. Never route them through the legacy CoreHost.
 requireMethods(workspace,["enqueueOperation","setState"]);
 const root=await realpath(resolve(object(storage.config).root));
 const key=sha(JSON.stringify([input.instanceId,input.profileId,input.branchId??"main","dsh-0.1.5","dsh-0.1.5-v3-jsonl-zstd-v1"]));
 if(basename(root)!=="sessions"||basename(dirname(root))!==key||basename(dirname(dirname(root)))!=="native-spaces")throw new TypeError("Core writes require this instance's Broker native space");
 const assertSpace=async()=>{const state=object(JSON.parse(await readFile(join(dirname(root),"space.json"),"utf8")));if(state.key!==key||state.owner!==input.runId||!["ready","clean"].includes(state.state))throw new TypeError("RC2 native-space owner is not this run");};await assertSpace();
 for(const [field,role] of [["sessions","session"],["sessionPersistence","jsonlPersistence"],["workspaceRegistry","workspace"],["sessionProjectionCache","projectionCache"]] as const){const implementation=loaded[role]!.default;if(typeof implementation!=="function"||!(ctx[field] instanceof implementation))throw new TypeError(`RC2 live service does not belong to the attested module: ${field}`);}
 // The attested cache service owns this single-open domain. Borrow the public
 // facility lookup without opening a second owner or closing the host's domain.
 const domain=ctx.storageDomain.get(loaded.projectionCache!.projectionCacheDomainSpec.name);
 if(!domain)throw new TypeError("RC2 projection cache domain is not initialized");
 requireMethods(domain,["table"]);
 const table=domain.table("sessions");requireMethods(table,["get","put","delete"]);
 const original={open:storage.open.bind(storage),create:storage.create.bind(storage),stat:storage.stat.bind(storage),list:storage.list.bind(storage)};
 type Owner={id:string;handle?:Dsh015SessionHandle};const local=new AsyncLocalStorage<Owner>(),reserved=new Set<string>(),externalWriters=new Map<string,number>();const disposers:(()=>void)[]=[];
 const check=(id:string)=>{if(reserved.has(id)&&local.getStore()?.id!==id)throw new Error(`DSH_BUSY: Maintenance owns ${id}`);};
 const patch=(target:ObjectRecord,name:string,wrap:(old:(...args:any[])=>any)=>(...args:any[])=>any)=>{const descriptor=Object.getOwnPropertyDescriptor(target,name),old=target[name],next=wrap(old.bind(target));Object.defineProperty(target,name,{configurable:true,writable:true,value:next});disposers.push(()=>{if(Object.getOwnPropertyDescriptor(target,name)?.value!==next)throw new Error(`RC2 guard was replaced: ${name}`);if(descriptor)Object.defineProperty(target,name,descriptor);else delete target[name];});};
 const track=async(id:string,action:()=>Promise<Dsh015SessionHandle>)=>{check(id);if(local.getStore()?.id===id)return action();externalWriters.set(id,(externalWriters.get(id)??0)+1);let handle:Dsh015SessionHandle;try{handle=await action();}catch(e){externalWriters.set(id,externalWriters.get(id)!-1);throw e;}const close=handle.close.bind(handle);let released=false;handle.close=async()=>{try{await close();}finally{if(!released){released=true;externalWriters.set(id,externalWriters.get(id)!-1);}}};return handle;};
 try {
 patch(storage,"open",old=>(id,access,...rest)=>access==="write"?track(id,()=>old(id,access,...rest)):old(id,access,...rest));
 patch(storage,"create",old=>(header,...rest)=>track(header.id,()=>old(header,...rest)));
 patch(sessions,"prepare",old=>(id,...rest)=>{if(typeof id==="string")check(id);return old(id,...rest);});
 patch(sessions,"enter",old=>(session,...rest)=>{check(session.id);return old(session,...rest);});
 } catch (error) { for(const dispose of disposers.reverse())dispose();throw error; }
 const borrowed=(handle:Dsh015SessionHandle):Dsh015SessionHandle=>({id:handle.id,header:handle.header,inheritedEventCount:handle.inheritedEventCount,access:handle.access,read:handle.read.bind(handle),append:handle.append.bind(handle),flush:handle.flush.bind(handle),close:async()=>{}});
 const persistence:Dsh015SessionPersistence={stat:original.stat,list:original.list,open:async(id,access)=>{const owner=local.getStore();if(access==="read")return original.open(id,access);if(owner?.id!==id)throw new TypeError("Offline admission is required before opening a writer");owner.handle??=await original.open(id,"write");return borrowed(owner.handle!);},create:async(header,options)=>{const owner=local.getStore();if(owner?.id!==header.id||owner.handle)throw new TypeError("Offline create has no exclusive admission");owner.handle=await original.create(header,options);return borrowed(owner.handle!);}};
 const withOfflineSession=async<T>(id:string,action:()=>Promise<T>):Promise<T>=>{
  if(reserved.has(id)||externalWriters.get(id)||sessions.get(id)!==undefined)throw new Error(`DSH_BUSY: ${id}`);reserved.add(id);
  const owner:Owner={id};try{return await local.run(owner,async()=>{await assertSpace();if(await original.stat(id))owner.handle=await original.open(id,"write");return action();});}finally{try{await owner.handle?.close();}finally{reserved.delete(id);}}
 };
 const setArchive=async(id:string,archived:boolean)=>{if(archived){await workspace.archiveSession(id);return;}await workspace.enqueueOperation(async()=>{const state=object(workspace.state);if(!Array.isArray(state.archivedSessionIds))throw new TypeError("Pinned RC2 workspace state drift");await workspace.setState({...state,archivedSessionIds:state.archivedSessionIds.filter((v:unknown)=>v!==id)});});};
 const captureWorkspace=async(id:string,workspaceId?:string)=>{const entity=workspaceId===undefined?workspace.list().find((w:any)=>w.sessionIds.includes(id)):workspace.get(workspaceId);const index=entity?.sessionIds.indexOf(id)??-1;return {workspaceId:entity?.id??workspaceId??null,memberIndex:index<0?null:index,beforeSessionId:index<0?null:entity.sessionIds[index+1]??null,archived:workspace.archivedSessionIds.includes(id)};};
 const metadata:Dsh015MetadataHost={captureWorkspace,captureProjection:async(id)=>{const record=table.get(id);return record===undefined?{present:false}:{present:true,record:structuredClone(record)};},captureRuntime:async(id)=>({coordinator:sessions.get(id)===undefined?"cold":"live",queryIndex:sha(canonicalJson(await original.stat(id)?await ctx.sessionQuery.readSession(id):null))}),attachWorkspace:async(id,w)=>{const entity=workspace.get(w);if(!entity)throw new TypeError("Unknown RC2 workspace");await entity.attachSession(id);},setArchive,invalidateProjection:async(id)=>{await table.delete(id);},reconcileRuntime:async(id)=>{if(await original.stat(id))await ctx.sessionQuery.readSession(id);},restoreWorkspace:async(id,snapshot)=>{for(const entity of workspace.list()){if(entity.sessionIds.includes(id)&&(snapshot.workspaceId!==entity.id||snapshot.memberIndex===null))await entity.detachSession(id);}if(snapshot.workspaceId!==null&&snapshot.memberIndex!==null){const entity=workspace.get(snapshot.workspaceId);if(!entity)throw new TypeError("Captured workspace no longer exists");await entity.attachSession(id);await entity.insertSessionBefore(id,snapshot.beforeSessionId??undefined);}await setArchive(id,snapshot.archived);},restoreProjection:async(id,snapshot)=>{if(snapshot.present)await table.put(id,snapshot.record);else await table.delete(id);}};
 const ownedPath=async(path:string)=>{const suffix=relative(root,path);if(suffix===".."||suffix.startsWith(`..${sep}`)||isAbsolute(suffix))throw new TypeError("Offline restore escaped native space");let current=dirname(path);while(current!==root){if((await lstat(current)).isSymbolicLink())throw new TypeError("Offline restore symlink refused");current=dirname(current);}return path;};
 const restoreOfflineSession=async(snapshot:DshSessionArtifactSnapshot)=>{
  await assertSpace();const owner=local.getStore();if(owner?.id!==snapshot.sessionId)throw new TypeError("Offline restore has no admission");const current=await original.stat(snapshot.sessionId);if(!current){if(!snapshot.exists)return;throw new TypeError("Captured session disappeared; recovery requires a fresh prepared run");}
  if(!owner.handle)throw new TypeError("Offline restore must hold the official JSONL writer lock");await owner.handle.flush();
  const plain=v3NativeArtifactPath(root,object(current.header),"none"),compressed=v3NativeArtifactPath(root,object(current.header),"zstd");const candidates=[];for(const path of [plain,compressed])if(await lstat(path).then(s=>s.isFile()&&!s.isSymbolicLink(),()=>false))candidates.push(path);if(candidates.length!==1)throw new TypeError("Offline restore requires exactly one V3 artifact");const path=await ownedPath(candidates[0]!);
  const generations=(await readdir(dirname(path))).filter(n=>/^session(?:\.v[0-9]+)?\.jsonl(?:\.zstd)?$/u.test(n));if(generations.length!==1)throw new TypeError("Offline rollback refuses retained or future generations");
  if(!snapshot.exists){await unlink(path);return;}
  const decoded=object(JSON.parse(Buffer.from(snapshot.artifact,"base64").toString("utf8")));if(canonicalJson(decoded as never)!==canonicalJson({header:snapshot.header,events:snapshot.events,inheritedEventCount:snapshot.inheritedEventCount??0} as never))throw new TypeError("Offline snapshot payload mismatch");
  const artifact=validateV3Artifact(decoded as never);if(canonicalJson(artifact.header as never)!==canonicalJson(current.header as never))throw new TypeError("Immutable V3 header changed before rollback");
  if(!path.endsWith(".zstd"))throw new TypeError("Managed offline rollback requires the configured zstd codec");const description={relativePath:relative(root,path),header:artifact.header};const bytes=v3NativeSessionCodec.encode(artifact as never,description);const temporary=`${path}.${randomUUID()}.maintenance-tmp`;
  const file=await open(temporary,"wx",0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}try{v3NativeSessionCodec.verifyEncoded?.(await readFile(temporary),artifact as never,description);await rename(temporary,path);}finally{await unlink(temporary).catch((e:NodeJS.ErrnoException)=>{if(e.code!=="ENOENT")throw e;});}
 };
 const host=new Dsh015CoreHost({persistence,isSessionLive:id=>sessions.get(id)!==undefined||Boolean(externalWriters.get(id)),observation:async()=>{await verifyReceipt(input);return receipt.observation;},validateStoredEvents:(header,events)=>loaded.sessionPersistence!.validateStoredEvents(header,events),metadata,withOfflineSession,restoreOfflineSession});
 return {host,expectedContractFingerprint:receipt.expectedContractFingerprint,materializationProbe:()=>probeBuiltDsh015CoreHost(receipt.materialization),dispose:async()=>{if(reserved.size)throw new Error("Cannot dispose an active offline transaction");for(const dispose of disposers.reverse())dispose();}};
}

/** Collect a reviewable receipt from the actual importer closure; caller approves its digest after validation. No files are written. */
export async function collectDsh015CoreBindingReceipt(input:{readonly importAnchor:string;readonly materialization:{readonly sourceHash:string;readonly artifactHash:string}}):Promise<Dsh015CoreBindingReceipt>{
 const anchor=input.importAnchor.startsWith("file:")?fileURLToPath(input.importAnchor):input.importAnchor,require=createRequire(anchor),packages:Record<string,{manifestPath:string;entryPath:string;manifestSha256:string;entrySha256:string}>={},packageVersions:Record<string,string>={},implementationHashes:Record<string,string>={};
 for(const [role,name] of Object.entries(modules)){
  const entryPath=await realpath(require.resolve(name));let directory=dirname(entryPath),manifestPath:string|undefined;
  for(;;){const candidate=join(directory,"package.json");try{const value=JSON.parse(await readFile(candidate,"utf8"));if(value.name===name){manifestPath=candidate;break;}}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}const parent=dirname(directory);if(parent===directory)break;directory=parent;}
  if(manifestPath===undefined)throw new TypeError(`Cannot locate resolved manifest for ${name}`);
  const manifestBytes=await readFile(manifestPath),entryBytes=await readFile(entryPath),manifest=JSON.parse(manifestBytes.toString("utf8"));if(manifest.version!=="0.1.5-rc.2")throw new TypeError(`Mixed RC2 package ${name}`);
  const entrySha256=sha(entryBytes);packages[name]={manifestPath,entryPath,manifestSha256:sha(manifestBytes),entrySha256};packageVersions[name]=manifest.version;implementationHashes[role]=`sha256:${entrySha256}`;
 }
 const observation:Dsh015CoreContractObservation={platformVersion:"0.1.5-rc.2",sessionFormatVersion:3,packageVersions,implementationHashes,methods:{sessionPersistence:["stat","list","open","create"],sessionHandle:["read","append","flush","close"],session:["validateStoredEvents"]}};
 return {schemaVersion:1,node:await actualNode(),observation,expectedContractFingerprint:dsh015CoreContractFingerprint(observation),packages,materialization:input.materialization};
}
