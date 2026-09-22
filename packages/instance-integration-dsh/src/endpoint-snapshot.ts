import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';
import type { CanonicalEndpointSnapshot, CanonicalProjectionInput, LogicalSessionId, NativeSessionArtifact, NativeSessionId, LogicalWorkspaceId } from '@linmu/dsh-session-contracts';
import { IntegrationError } from '@linmu/dsh-session-contracts';
import { adapter, inspectNativeSpace as inspectV3NativeSpace } from '@linmu/dsh-session-extension-gpt-compat';
import { canonicalEventsFor } from './instance-workspace-source.js';
import { resolveInstanceWorkspaceFolders } from './instance-write-back.js';
import { readEndpointProjection, projectionSourceDigest } from './projection-receipt.js';
import { remapProjectedAppend } from '@linmu/dsh-session-extension-gpt-compat';

/** Translate native rows only here. The engine never inspects cwd, seq, or host event types. */
export async function readEndpointSnapshot(input: {
  readonly homeRoot: string; readonly endpointId: string; readonly nativeSessionId: string;
  readonly logicalSessionId: LogicalSessionId; readonly projection: CanonicalProjectionInput;
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly workspaceNames?: ReadonlyMap<string, string>;
  readonly folders?: readonly { readonly workspaceId: string; readonly path: string }[];
  readonly inspect?: (root: string) => Promise<readonly NativeSessionArtifact[]>;
}): Promise<CanonicalEndpointSnapshot> {
  const artifacts = await (input.inspect ?? inspectV3NativeSpace)(join(input.homeRoot, 'sessions'), { nativeSessionId: input.nativeSessionId });
  const actual = artifacts.find(item => String(item.nativeSessionId) === input.nativeSessionId);
  if (!actual || !actual.complete) throw new IntegrationError('SYNC_SOURCE_UNSTABLE', '实例会话尚未完整落盘，请稍后重试。');
  const cwd = (actual.header as { cwd?: unknown }).cwd;
  if (typeof cwd !== 'string') throw new IntegrationError('SESSION_NOT_SYNCED', '会话没有已映射的工作区。');
  const selected = new Set(input.projection.workspaces.map(item => String(item.id)));
  // A saved selection defines its target paths even before a successful write-back receipt.
  // Reuse the exact adapter planner, then require a registered native directory. Never infer a
  // mapping from a display name or import an unrelated same-name directory outside that plan.
  const folders = input.folders ?? (await resolveInstanceWorkspaceFolders({ stateRoot: input.stateRoot,
    workspaceRoot: input.workspaceRoot, instanceHome: input.homeRoot, instanceId: input.endpointId,
    projection: input.projection, names: input.workspaceNames ?? new Map(input.projection.workspaces.map(item => [String(item.id), item.name])) }))
    .filter(item => selected.has(item.workspaceId) && item.owned);
  const folder = folders.find(item => resolve(item.path).toLowerCase() === resolve(cwd).toLowerCase());
  if (!folder) throw new IntegrationError('SESSION_NOT_SYNCED', '会话已移出当前同步工作区。');
  const existing = input.projection.sessions.find(item => item.session.id === input.logicalSessionId);
  const receipt = await readEndpointProjection(input.stateRoot, input.endpointId, input.nativeSessionId);
  let nativePrefix = 0;
  let sourceNativeCount = 0;
  let nativeToSource: number[] = [];
  if (existing) {
    let expected: readonly unknown[] | undefined;
    if (receipt) {
      if (projectionSourceDigest(existing.events.slice(0, receipt.sourceCount)) !== receipt.sourceDigest) throw new Error('SYNC_PROJECTION_SOURCE_CHANGED');
      const later = existing.events.slice(receipt.sourceCount);
      if (later.some(event => event.source.instanceId !== input.endpointId || String(event.source.sessionId) !== input.nativeSessionId)) throw new Error('SYNC_PROJECTION_REBASE_REQUIRED');
      expected = [...receipt.nativeEvents, ...later.map(event => event.rawPayload)];
      sourceNativeCount = receipt.sourceNativeCount + later.length;
      nativeToSource = [...receipt.nativeToSource, ...later.map((_, index) => receipt.sourceNativeCount + index)];
    } else await adapter.materialize({ ...input.projection, sessions: [existing] }, {
      writeWorkspace: async () => undefined,
      writeSession: async (_id: NativeSessionId, payload) => { expected = (payload as unknown as { events: unknown[] }).events; },
    });
    if (!expected || actual.events.length < expected.length || expected.some((event, i) => !isDeepStrictEqual(event, actual.events[i])))
      throw new IntegrationError('SYNC_NATIVE_PREFIX_CHANGED', '实例历史与已提交版本不一致，未覆盖真源。');
    nativePrefix = expected.length;
    if (!receipt) { sourceNativeCount = nativePrefix; nativeToSource = expected.map((_, index) => index); }
  }
  const baseEvents = existing?.events ?? [];
  const nextSequence = (baseEvents.at(-1)?.sequence ?? -1) + 1;
  const mapping = [...nativeToSource, ...actual.events.slice(nativePrefix).map((_, index) => sourceNativeCount + index)];
  const appended = canonicalEventsFor({ artifact: actual, instanceId: input.endpointId,
    logicalSessionId: () => String(input.logicalSessionId) }).slice(nativePrefix).map((event, index) => ({ ...event, sequence: nextSequence + index,
      ...(receipt ? { id: `${event.id}:projection:${receipt.sourceDigest}` } : {}),
      ...(receipt ? { extensions: { ...event.extensions, nativeProjectionEvent: remapProjectedAppend(event.rawPayload!, sourceNativeCount + index, mapping) } } : {}) }));
  const state = JSON.parse(await readFile(join(input.homeRoot, 'storages', 'workspace.json'), 'utf8')) as {
    unit?: { name?: string; version?: number }; global?: { archivedSessionIds?: string[] };
  };
  if (state.unit?.name !== 'workspace' || state.unit.version !== 2 || !Array.isArray(state.global?.archivedSessionIds))
    throw new IntegrationError('SYNC_HOST_STATE_UNSUPPORTED', '宿主工作区状态格式不受支持。');
  const now = new Date().toISOString();
  const titleEvent = [...actual.events].reverse().find(value => typeof value === 'object' && value !== null
    && (value as { type?: string }).type === 'session/title') as { data?: { title?: unknown } } | undefined;
  const title = typeof titleEvent?.data?.title === 'string' ? titleEvent.data.title : existing?.session.title ?? input.nativeSessionId;
  const archived = state.global.archivedSessionIds.includes(input.nativeSessionId);
  return { logicalSessionId: input.logicalSessionId, baseVersionId: existing?.session.headVersionId ?? null,
    events: [...baseEvents, ...appended], title, tags: existing?.session.tags ?? [],
    archivedAt: archived ? existing?.session.archivedAt ?? now : null,
    workspaceId: folder.workspaceId as LogicalWorkspaceId, observedAt: now };
}
