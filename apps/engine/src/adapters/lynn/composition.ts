import type { SessionMaintenanceEngine } from '../../engine.js';
import type { ExtensionDataService, ExtensionDataHooks } from '../../extensions/service.js';
import { coordinateAsyncMethods, type SqliteExtensionRepository } from '@linmu/dsh-session-store';
import { annotationMirrorSyncSchema, ExtensionDataError, type AnnotationMirrorSync, type AnnotationMirrorSyncResult } from '@linmu/dsh-session-contracts';
import { readJsonBody } from '../../http/body.js';
import { SessionContextService } from './session-context-service.js';
import { NativeContextService } from './native-context-service.js';
import { SessionGraphService } from './session-graph-service.js';
import { SessionKnowledgeService } from './session-knowledge-service.js';
import { UserRequestIndexService } from './user-request-index-service.js';
import { routeNativeContext } from './native-context-routes.js';
import { routeSessionContext } from './session-context-routes.js';
import { routeSessionGraph } from './session-graph-routes.js';
import { routeSessionKnowledge } from './session-knowledge-routes.js';
import { synchronizeAnnotationMirrors } from './annotation-sync.js';
import { presentGraphList } from './session-graph-titles.js';
import { directoryVisibilitySql } from './directory-policy.js';

// Compatibility surface is supplied by this adapter. A bare Engine has no plugin services.
declare module '../../engine.js' {
  interface SessionMaintenanceEngine {
    readonly sessionContext: SessionContextService;
    readonly nativeContext: NativeContextService;
    readonly sessionGraph: SessionGraphService;
    readonly sessionKnowledge: SessionKnowledgeService;
    readonly userRequests: UserRequestIndexService;
  }
}
declare module '../../extensions/service.js' {
  interface ExtensionDataService {
    syncAnnotation(input: AnnotationMirrorSync, engine: SessionMaintenanceEngine): Promise<AnnotationMirrorSyncResult>;
  }
}
export function lynnExtensionHooks(store: SqliteExtensionRepository): ExtensionDataHooks {
  return { directoryVisibilitySql, presentList: (query, page) => presentGraphList(store.database, query, page) };
}
export function attachLynn(engine: SessionMaintenanceEngine, store: SqliteExtensionRepository): void {
  engine.descendantReferenceTypes.add("obsidian-reference");
  const services = { sessionContext: new SessionContextService(engine), nativeContext: new NativeContextService(engine),
    sessionGraph: new SessionGraphService(engine), sessionKnowledge: new SessionKnowledgeService(engine), userRequests: new UserRequestIndexService(engine) };
  Object.defineProperties(engine, Object.fromEntries(Object.entries(services).map(([key, value]) => [key, { value, configurable: true }])));
  if (engine.writes) coordinateAsyncMethods(services.sessionContext, ['read', 'endExecution'], engine.writes, 'context-execution');
  engine.runClosed.add(() => services.sessionContext.cleanupExecutions());
  const extension = engine.extensions;
  if (extension) attachLynnExtensionService(extension, store);
  engine.extensionRoutes.push(async (request, response, url, browser) => {
    if (await routeNativeContext(request, response, url, engine, browser)
      || await routeSessionContext(request, response, url, engine)
      || await routeSessionGraph(request, response, url, engine)
      || await routeSessionKnowledge(request, response, url, engine)) return true;
    if (request.method !== 'POST' || url.pathname !== '/v1/extensions/annotation-sync') return false;
    if (!extension) throw new Error('Lynn extension storage is unavailable');
    const input = annotationMirrorSyncSchema.parse(await readJsonBody(request, 512 * 1024));
    const result = await engine.runWrite('annotation-mirror-sync', () => extension.syncAnnotation(input, engine));
    response.setHeader('content-type', 'application/json; charset=utf-8'); response.end(JSON.stringify(result)); return true;
  });
}

export function attachLynnExtensionService(extension: ExtensionDataService, store: SqliteExtensionRepository): void {
  extension.syncAnnotation = (input, target) => synchronizeAnnotationMirrors(store, target, input, scope => {
    const panel = extension.panels().find(item => item.scope.instanceId === scope.instanceId && item.scope.profileId === scope.profileId && item.scope.namespace === scope.namespace);
    if (panel?.status !== 'ready') throw new ExtensionDataError('EXTENSION_UNAVAILABLE', '此实例尚未启用兼容的扩展；保存的数据仍然保留。');
    return panel.writerId;
  });
}
