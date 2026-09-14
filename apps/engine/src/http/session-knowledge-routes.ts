import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { knowledgeWriteSchema,knowledgeListSchema,knowledgeMigrationSchema,knowledgeNamespaceSchema,jsonValueSchema } from '@linmu/dsh-session-contracts';
import type { SessionMaintenanceEngine } from '../engine.js';
import { readJsonBody } from './body.js';
const id=z.string().min(1).max(256),base=z.strictObject({runId:id});
export async function routeSessionKnowledge(request:IncomingMessage,response:ServerResponse,url:URL,engine:SessionMaintenanceEngine) {
  if(!url.pathname.startsWith('/v1/session-knowledge/')||request.method!=='POST')return false;
  const body=await readJsonBody(request,512*1024),op=url.pathname.slice('/v1/session-knowledge/'.length);let result:unknown;
  if(op==='status'){const q=base.parse(body);result=await engine.sessionKnowledge.status(q.runId);}
  else if(op==='list'){const q=base.extend({input:knowledgeListSchema}).parse(body);result=await engine.sessionKnowledge.list(q.runId,q.input);}
  else if(op==='get'){const q=base.extend({namespace:knowledgeNamespaceSchema,objectId:id}).parse(body);result=await engine.sessionKnowledge.get(q.runId,q.namespace,q.objectId);}
  else if(op==='write'){const q=base.extend({input:knowledgeWriteSchema}).parse(body);result=await engine.runWrite('knowledge-write',()=>engine.sessionKnowledge.write(q.runId,q.input));}
  else if(op==='migrate'){const q=base.extend({input:knowledgeMigrationSchema}).parse(body);result=await engine.runWrite('knowledge-migration',()=>engine.sessionKnowledge.migration(q.runId,q.input));}
  else if(op==='legacy-state'){const q=base.extend({nativeSessionId:id}).parse(body);result=await engine.sessionKnowledge.legacyState(q.runId,q.nativeSessionId);}
  else if(op==='legacy-save'){const q=base.extend({input:z.strictObject({document:z.object({sessionId:id,stickers:z.array(jsonValueSchema).max(500)}),expectedRevision:id,enqueueBacklinkDelete:jsonValueSchema.optional(),acknowledgeStickerId:id.optional()})}).parse(body);result=await engine.runWrite('knowledge-legacy-save',()=>engine.sessionKnowledge.legacySave(q.runId,q.input));}
  else return false;
  response.statusCode=200;response.setHeader('content-type','application/json; charset=utf-8');response.setHeader('cache-control','no-store');response.end(JSON.stringify(result));return true;
}
