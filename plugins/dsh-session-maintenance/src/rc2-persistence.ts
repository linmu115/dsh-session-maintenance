import type {} from '@deepseek-ai/dsh-workspace';
import { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type { Context } from '@deepseek-ai/cordis';
import { SessionLogOffset, type SessionHeader, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence';
import type { SessionPersistenceProjectionContext } from './projection-runtime.js';
import { assertReleasedV3Header } from '@deepseek-ai/dsh-session-format-v2-to-v3';

/** Match the official RC2 JSONL writer's default at the live-session boundary. */
export function rc2RuntimeHeader(header: SessionHeader): SessionHeader {
  const normalized = { ...header, delegationDepth: header.delegationDepth === undefined ? 0 : header.delegationDepth };
  assertReleasedV3Header(normalized);
  return normalized;
}

/** RC2 storage ownership stays inside this port until hydration has durably finished. */
export function rc2ProjectionContext(ctx: Pick<Context, 'sessionPersistence' | 'workspaceRegistry' | 'sessionProjectionCache'>): SessionPersistenceProjectionContext {
  const handles = new Map<string, SessionHandle>();
  const failures = new Map<string, unknown>();
  const handle = (id: string) => {
    if (failures.has(id)) throw new Error(`Projection hydration failed for ${id}; a new prepared run is required`, { cause: failures.get(id) });
    const value = handles.get(id);
    if (value === undefined) throw new Error(`Projection writer is not owned for ${id}`);
    return value;
  };
  return {
    workspaceRegistry: ctx.workspaceRegistry as unknown as SessionPersistenceProjectionContext['workspaceRegistry'],
    sessionProjectionCache: ctx.sessionProjectionCache as unknown as SessionPersistenceProjectionContext['sessionProjectionCache'],
    sessionPersistence: {
      async create(header, inheritedEventCount) {
        if (header.version !== 3) throw new Error('RC2 projection requires a validated V3 header');
        if (handles.has(header.id) || failures.has(header.id)) throw new Error(`Projection hydration already started for ${header.id}`);
        const writer = await ctx.sessionPersistence.create(header as SessionHeader, {
          ...(inheritedEventCount === undefined ? {} : { inheritedEventCount: SessionLogOffset(inheritedEventCount) }),
        });
        handles.set(header.id, writer);
      },
      async append(id, events) {
        const writer = handle(id);
        try { await writer.append(events as unknown as readonly SessionEvent[]); }
        catch (error) { failures.set(id, error); handles.delete(id); await writer.close(); throw error; }
      },
      async finishHydration(id) {
        const writer = handle(id);
        try { await writer.flush(); }
        catch (error) { failures.set(id, error); throw error; }
        finally { handles.delete(id); await writer.close(); }
      },
      async list() { return (await ctx.sessionPersistence.list()).map(row => row.header); },
      async abortHydration(id, error) {
        failures.set(id, error);
        const writer = handles.get(id); handles.delete(id);
        await writer?.close();
      },
      async closeHydrationHandles() {
        const pending = [...handles.values()]; handles.clear();
        const results = await Promise.allSettled(pending.map(writer => writer.close()));
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, 'Projection writers could not all close');
      },
    },
  };
}

/** Borrow the host cache domain; its service retains the only open/close ownership. */
export async function bindRc2ProjectionContext(ctx: Context) {
  const domain = ctx.storageDomain.get(projectionCacheDomainSpec.name);
  if (domain === undefined || domain.name !== projectionCacheDomainSpec.name) throw new TypeError('RC2 projection cache domain is not initialized');
  const table = domain.table('sessions');
    const workspace = ctx.workspaceRegistry as unknown as SessionPersistenceProjectionContext['workspaceRegistry'];
    if (typeof workspace.replaceHeaderIndex !== 'function') throw new TypeError('Pinned RC2 workspace header index is unavailable');
    const context = rc2ProjectionContext({ sessionPersistence: ctx.sessionPersistence, workspaceRegistry: ctx.workspaceRegistry,
      sessionProjectionCache: { table } as unknown as Context['sessionProjectionCache'] });
    return { context, dispose: async () => { await context.sessionPersistence.closeHydrationHandles!(); } };
}
