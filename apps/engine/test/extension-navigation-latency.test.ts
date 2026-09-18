import { expect, it, vi } from 'vitest';
import { routeExtensionRequest } from '../src/http/extension-routes.js';
import type { SessionMaintenanceEngine } from '../src/engine.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
it('navigation and unrelated namespaces never wait for GPT event indexing', async () => {
 const refresh = vi.fn(async () => {}); const runWrite = vi.fn(async (_name, action) => action());
 const service = { refreshNativeIndexes: refresh, businessPanels: () => [], panels: () => [], list: () => ({items:[]}) };
 const engine = { extensions: service, runWrite, instances: [] } as unknown as SessionMaintenanceEngine;
 const response = { setHeader: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
 for (const path of ['/v1/extensions/business-panels','/v1/extensions/panels','/v1/extensions/objects?instanceId=copy&profileId=web&namespace=thoughtdag'])
   await routeExtensionRequest({method:'GET'} as IncomingMessage,response,new URL(path,'http://localhost'),engine);
 expect(refresh).not.toHaveBeenCalled();
 await routeExtensionRequest({method:'GET'} as IncomingMessage,response,new URL('/v1/extensions/objects?instanceId=copy&profileId=web&namespace=gpt-compat','http://localhost'),engine);
 expect(refresh).toHaveBeenCalledOnce();
});
