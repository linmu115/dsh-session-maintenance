// Read-only compatibility check against an explicitly selected official RC1 installation.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readdirSync,existsSync,realpathSync,readFileSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {materializeRc1,normalizeRc1Append} from '../packages/adapter-dsh-rc1/dist/index.js';
const root=realpathSync(process.env.DSH_OFFICIAL_ROOT);
const store=join(root,'node_modules/.pnpm');
const name='@deepseek-ai/dsh-session-persistence';
const matches=[...new Set(readdirSync(store).map(d=>join(store,d,'node_modules',name,'package.json')).filter(existsSync).map(p=>realpathSync(p)))];
assert.equal(matches.length,1);
const manifest=realpathSync(matches[0]);
assert.equal(JSON.parse(readFileSync(manifest,'utf8')).version,'0.1.2-rc.1');
const entry=realpathSync(createRequire(manifest).resolve(name));
assert.ok(!relative(root,entry).startsWith('..')&&!isAbsolute(relative(root,entry)));
const {PersistenceCoordinator}=await import(pathToFileURL(entry));
const at='2026-09-10T00:00:00.000Z';
const raw=[{type:'dsh-runtime/detail',seq:0,time:Date.parse(at),data:{id:'synthetic-execution',phase:'start',state:'completed',model:'synthetic',items:[]}}];
const operation=events=>({runId:'synthetic-run',operationId:'synthetic-op',nativeSessionId:'synthetic',nativeRevision:events.length,observedAt:at,payload:{logicalSessionId:'synthetic-logical',canonicalHistoryMode:'native',events}});
async function project(events){let payload;await materializeRc1({run:{id:'synthetic-run'},workspaces:[],sessions:[{session:{id:'synthetic-logical',title:'synthetic',tags:[],createdAt:at,updatedAt:at,headVersionId:'synthetic-v'},events,workspaceId:null,projectRoot:null}]},{writeWorkspace:async()=>{},writeSession:async(_id,p)=>{payload=p}});return payload;}
async function read(payload){
 const context={effect(){},on(){},sessions:{list:()=>[]}};
 const backend={name:'synthetic-memory',loadStored:async()=>({meta:structuredClone(payload.header),inheritedEventCount:0,events:structuredClone(payload.events),revision:'synthetic:1'})};
 return new PersistenceCoordinator(context,backend).readFrom(payload.header.id,0);
}
const normalized=await normalizeRc1Append(operation(raw));
const first=await project(normalized.events);
await assert.rejects(read({...first,events:raw}),/unknown to this harness and not marked ignorable/);
const loaded=await read(first);
assert.equal(loaded.events[0].ignorable,true);
assert.deepEqual(loaded.events[0].data,raw[0].data);
const second=await project((await normalizeRc1Append(operation(first.events))).events);
assert.deepEqual((await read(second)).events,loaded.events);
await assert.rejects(read({...first,events:[{...raw[0],type:'future/required'}]}),/unknown to this harness/);
console.log(JSON.stringify({officialVersion:'0.1.2-rc.1',oldRecordRefused:true,projectedRecordReadable:true,detailPayloadPreserved:true,repeatedProjectionStable:true,unknownRequiredEventStillRefused:true}));
