import type { Context } from '@deepseek-ai/cordis';
import type { EngineConnectionProvider } from './engine-proxy.js';
import type { ExtensionPanel } from '@linmu/dsh-session-contracts';

const operations = new Set(['status', 'inspect', 'requests', 'window-set', 'source-set', 'pin', 'release',
  'graph-edit', 'discover', 'materials-register', 'release-plans', 'release-receipt', 'user-read']);

export function nativeContextReady(panels: readonly ExtensionPanel[], instanceId: string, profileId: string, pluginVersion: string): boolean {
  return panels.some(panel => panel.scope.instanceId === instanceId && panel.scope.profileId === profileId
    && panel.scope.namespace === 'annotation-context' && panel.pluginVersion === pluginVersion
    && panel.configured && panel.enabled && panel.status === 'ready');
}

/** Capability binding for the current admitted run. No consumer receives the Engine token. */
export class MaintenanceNativeContext {
  readonly protocolVersion = 1 as const;
  readonly capabilities = { nativeSurface: true, tools: true } as const;
  constructor(private readonly connection: EngineConnectionProvider, private readonly runId: string,
    private readonly flush: (nativeSessionId: string) => Promise<unknown>,
    private readonly ensureReady?: (signal?: AbortSignal) => Promise<void>) {}

  request<T = unknown>(nativeSessionId: string, operation: string, input: object, signal?: AbortSignal): Promise<T> {
    if (operation === 'user-read') throw new Error('User preview is not a model read capability');
    return this.dispatch(nativeSessionId, operation, input, 'model', signal);
  }
  requestAsUser<T = unknown>(nativeSessionId: string, operation: string, input: object, signal?: AbortSignal): Promise<T> {
    if (['materials-register', 'release-plans', 'release-receipt'].includes(operation)) throw new Error('Surface operations require the native execution host');
    return this.dispatch(nativeSessionId, operation, input, 'user', signal);
  }
  private async dispatch<T>(nativeSessionId: string, operation: string, input: object, actor: 'model' | 'user', signal?: AbortSignal): Promise<T> {
    if (!operations.has(operation)) throw new Error('Unknown native context operation');
    if (!nativeSessionId || nativeSessionId.length > 256) throw new Error('A valid native session is required');
    for (const key of ['runId', 'nativeSessionId', 'targetNativeSessionId', 'ownerSessionId', 'profileId', 'instanceId', 'actor']) {
      if (Object.hasOwn(input, key)) throw new Error(`Native context scope cannot be overridden: ${key}`);
    }
    signal?.throwIfAborted();
    await this.ensureReady?.(signal);
    signal?.throwIfAborted();
    // Material claims and applied receipts must refer to an already durable native log.
    if (['materials-register', 'release-receipt', 'requests', 'user-read'].includes(operation)) await this.flush(nativeSessionId);
    signal?.throwIfAborted();
    const connection = await this.connection.current();
    const hostOperation = ['materials-register', 'release-plans', 'release-receipt'].includes(operation);
    const scoped = input as { executionId?: unknown };
    const executionId = actor === 'user' ? `user:${nativeSessionId}` : scoped.executionId;
    if (typeof executionId !== 'string' || !executionId || executionId.length > 256) throw new Error('An execution identity is required');
    const response = await fetch(`${connection.origin}/v1/native-context/${operation}`, {
      method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, runId: this.runId, targetNativeSessionId: nativeSessionId, actor: hostOperation ? 'host' : actor, executionId }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok) {
      const failure = (result as { error?: { message?: string; code?: string } }).error;
      throw Object.assign(new Error(failure?.message ?? 'Maintenance 原生上下文能力暂不可用'),
        { code: failure?.code ?? 'NATIVE_CONTEXT_UNAVAILABLE', status: response.status });
    }
    return result as T;
  }
}
export function registerMaintenanceNativeContext(ctx: Context, value: MaintenanceNativeContext) {
  ctx.provide('maintenanceNativeContext', value);
}
declare module '@deepseek-ai/cordis' { interface Context { maintenanceNativeContext: MaintenanceNativeContext } }
