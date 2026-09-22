import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { CanonicalProjectionInput, LogicalWorkspaceId, ProjectionRun } from '@linmu/dsh-session-contracts';
import { adapter, gptCompatExtensionAdapter } from '@linmu/dsh-session-extension-gpt-compat';
import { v3NativeSessionId, filterNativePluginData } from '@linmu/dsh-session-adapter-0-1-5';
import type { PluginDataMappingSession } from '@linmu/dsh-session-adapter-host';
import type { WorkspaceWriteBackSummary as InstanceWriteBackSummary } from '@linmu/dsh-session-contracts';
import { writeBackProjectionToInstance } from './instance-session-writeback.js';
import { readWorkspaceMappings, saveWorkspaceMappings } from './workspace-mapping-store.js';
import { IntegrationError } from '@linmu/dsh-session-contracts';

/**
 * True-source → instance: put a selected workspace's sessions back into the instance.
 *
 * This is the direction the operator asks for from the board ("把这个工作区同步到实例"). It is the
 * exact mirror of joining: joining reads the instance's own session directory into Maintenance and
 * this writes Maintenance's canonical sessions into that same directory, at the path the adapter's
 * layout rule derives from each session's own `cwd` — one rule for both directions, so every file
 * this writes is a file the reader accepts.
 *
 * What it will never do: write a session the instance's saved range does not select. The range was
 * frozen when the policy was written, so an instance-native workspace that was never selected
 * cannot be touched even though the projection itself carries its sessions.
 */
export interface InstanceWriteBackOptions {
  readonly pluginData?: PluginDataMappingSession;
  readonly withNativeLocks?: import('./instance-session-writeback.js').WriteBackInput['withNativeLocks'];
  /** Adapter-owned host lease: holds flush/drain/exclusive access until the work completes. */
  readonly withWriteAccess?: <T>(work: () => Promise<T>) => Promise<T>;
  readonly synchronizeArchived?: (sessions: readonly { readonly nativeSessionId: string; readonly archived: boolean }[]) => Promise<void>;
  readonly bindIdentity?: (nativeSessionId: string, logicalSessionId: string, checkOnly: boolean) => Promise<void>;
  readonly stateRoot: string;
  readonly backupRoot: string;
  readonly journalPath: string;
  /**
   * Where the instance's workspaces live locally, one folder per Maintenance workspace.
   *
   * Maintenance itself has no workspaces: a "workspace" there is only a bucket that groups sessions,
   * and the instance needs a real directory to own them (`@deepseek-ai/dsh-workspace` resolves every
   * session's `cwd` and requires it to equal the registered workspace path). So the Engine maps each
   * bucket to its own folder under this root, named after the bucket, and writes the sessions with
   * that folder as their `cwd`. An existing folder is reused, never recreated.
   */
  readonly workspaceRoot: string;
  /** The instance's saved range, read from the same table the board writes. */
  readonly selectionFor: (instanceId: string) => { readonly revision: number; readonly selection:
    | { readonly kind: 'all' }
    | { readonly kind: 'ids'; readonly workspaceIds: readonly string[]; readonly includeUnassigned: boolean } };
  readonly memberships: () => Promise<ReadonlyMap<string, LogicalWorkspaceId | null>>;
  /** The bucket's display name, which also names its local folder. */
  readonly workspaceNames: () => Promise<ReadonlyMap<string, string>>;
  readonly loadProjection: (run: ProjectionRun) => Promise<CanonicalProjectionInput>;
}

export interface InstanceWriteBackRequest {
  readonly instanceId: string;
  readonly profileId: string;
  /** The instance's own sessions root; the adapter's layout rule adds the project directory. */
  readonly sessionsRoot: string;
  /**
   * The instance's DSH Home. It is read — never written — to learn which workspaces the instance
   * already owns, because a bucket that mirrors one of them must keep using that workspace's own
   * path instead of a second folder under the mapping root.
   */
  readonly instanceHome: string;
}

/** Sessions the adapter could not turn back into an instance payload, reported instead of thrown. */
export type WriteBackFailures = { logicalSessionId: string; message: string }[];

/** The run identity used to ask the projection source for this instance's frozen range. */
export function writeBackRunIdentity(instanceId: string, profileId: string): ProjectionRun {
  // The projection source resolves the range from the instance's stored policy, and only the
  // identity fields of a run are read for that; the state records that this is not a live run.
  return { id: `write-back-${instanceId}`, instanceId, profileId, state: 'closed' } as unknown as ProjectionRun;
}

/** Characters Windows refuses in a folder name, plus the trailing-dot/space rule. */
const UNSAFE_FOLDER = /[<>:"/\\|?*\u0000-\u001f]/gu;

/**
 * The local folder name for one Maintenance bucket.
 *
 * The bucket's own name is used so the folder is readable, with path-unsafe characters replaced;
 * a name that sanitises to nothing keeps a stable fallback instead of an empty path segment.
 */
export function workspaceFolderName(name: string, workspaceId: string): string {
  const cleaned = name.replace(UNSAFE_FOLDER, '_').replace(/[. ]+$/u, '').trim().slice(0, 120);
  return cleaned.length > 0 ? cleaned : workspaceId.replace(UNSAFE_FOLDER, '_');
}

/**
 * Registered native paths keyed by native workspace identity, preserving duplicate labels.
 *
 * A Maintenance bucket is a grouping of sessions, and one of those groupings can mirror a
 * workspace the instance itself created — the operator's own working directory. Mapping that bucket
 * to a *new* folder under the mapping root would relocate the instance's own sessions into a second
 * workspace that only looks like the first, so the instance's existing path wins: the operator's
 * rule is that a workspace which already exists is reused rather than recreated.
 *
 * A missing registry has no registered paths. An existing unsupported or malformed registry
 * blocks alignment; guessing a new folder would risk relocating the user's native workspace.
 */
export async function readRegisteredWorkspacePaths(homeRoot: string): Promise<ReadonlyMap<string, string>> {
  const text = await readFile(join(homeRoot, 'storages', 'workspace.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (text === undefined) return new Map();
  try {
    const parsed = JSON.parse(text) as {
      readonly unit?: { readonly name?: unknown; readonly version?: unknown };
      readonly tables?: { readonly workspaces?: Readonly<Record<string, { readonly path?: unknown; readonly title?: unknown }>> };
    };
    if (parsed.unit?.name !== 'workspace' || parsed.unit?.version !== WORKSPACE_STORE_VERSION) throw new Error('Unsupported workspace storage');
    const registered = new Map<string, string>();
    for (const [id, record] of Object.entries(parsed.tables?.workspaces ?? {})) {
      if (typeof record?.path !== 'string' || record.path.length === 0) continue;
      registered.set(id, record.path);
    }
    return registered;
  } catch { throw new IntegrationError('SYNC_HOST_STATE_UNSUPPORTED', '无法核验宿主工作区登记，对齐未执行。'); }
}

async function readArchivedSessions(homeRoot: string): Promise<ReadonlySet<string>> {
  const text = await readFile(join(homeRoot, 'storages', 'workspace.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (text === undefined) return new Set();
  try {
    const state = JSON.parse(text);
    if (state.unit?.name !== 'workspace' || state.unit?.version !== 2 || !Array.isArray(state.global?.archivedSessionIds)
      || state.global.archivedSessionIds.some((id: unknown) => typeof id !== 'string')) throw new Error('Unsupported archive storage');
    return new Set(state.global.archivedSessionIds);
  } catch { throw new IntegrationError('SYNC_HOST_STATE_UNSUPPORTED', '无法核验宿主归档状态，对齐未完成。'); }
}

/** The `workspaces` storage unit this reader understands; anything else is not interpreted. */
const WORKSPACE_STORE_VERSION = 2;

/** One bucket's resolved local folder: where the instance owns that bucket's sessions. */
export interface MappedWorkspaceFolder {
  readonly workspaceId: string;
  /** The folder name below the mapping root, after sanitising and duplicate resolution. */
  readonly folder: string;
  readonly path: string;
  /** The instance already owns a workspace at `path`; nothing has to be created for it. */
  readonly owned: boolean;
}

/**
 * Resolve every bucket to the local folder the instance owns it under — one rule, both callers.
 *
 * The write-back writes sessions with that folder as their `cwd`; the instance-side endpoint reports
 * the same folders so the instance can register them. Two implementations of this rule would drift,
 * and a drift here is not cosmetic: a session whose `cwd` names a folder the instance has not
 * registered falls out of every workspace.
 */
export function mapWorkspaceFolders(input: {
  readonly workspaceRoot: string;
  readonly registered: ReadonlyMap<string, string>;
  readonly buckets: readonly { readonly workspaceId: string; readonly name: string }[];
  readonly verifiedPaths?: ReadonlyMap<string, string>;
}): readonly MappedWorkspaceFolder[] {
  const claimed = new Map<string, string>();
  const mapped: MappedWorkspaceFolder[] = [];
  for (const [id, path] of input.verifiedPaths ?? []) {
    const key = resolve(path).toLowerCase();
    if (claimed.has(key) && claimed.get(key) !== id) throw new IntegrationError('SYNC_WORKSPACE_PATH_CONFLICT', '多个工作区不能共享同一物理目录。');
    claimed.set(key, id);
  }
  for (const bucket of [...input.buckets].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))) {
    const name = workspaceFolderName(bucket.name, bucket.workspaceId);
    let path = input.verifiedPaths?.get(bucket.workspaceId) ?? join(input.workspaceRoot, name);
    let attempt = 0;
    while (claimed.has(resolve(path).toLowerCase()) && claimed.get(resolve(path).toLowerCase()) !== bucket.workspaceId) {
      path = join(input.workspaceRoot, `${name}-${createHash('sha256').update(bucket.workspaceId).digest('hex').slice(0, 12)}${attempt++ ? `-${attempt}` : ''}`);
    }
    const folder = basename(path);
    claimed.set(resolve(path).toLowerCase(), bucket.workspaceId);
    const owned = [...input.registered.values()].some(value => resolve(value).toLowerCase() === resolve(path).toLowerCase());
    mapped.push({ workspaceId: bucket.workspaceId, folder, path, owned });
  }
  return mapped;
}

/** Reuse a native workspace only from this endpoint's canonical provenance, never from its label. */
export function verifiedWorkspacePaths(projection: CanonicalProjectionInput, endpointId: string,
  registered: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const paths = new Map<string, string>();
  for (const item of projection.sessions) {
    if (!item.workspaceId || !item.projectRoot || !item.events.some(event => event.source.platform === 'dsh' && event.source.instanceId === endpointId)) continue;
    const root = resolve(item.projectRoot).toLowerCase();
    const path = [...registered.values()].find(value => resolve(value).toLowerCase() === root);
    if (!path) continue;
    const previous = paths.get(String(item.workspaceId));
    if (previous && resolve(previous).toLowerCase() !== root) throw new Error('工作区存在多个原生目录来源，不能按名称选择');
    paths.set(String(item.workspaceId), path);
  }
  return paths;
}

export async function writeBackInstanceWorkspaces(options: InstanceWriteBackOptions, request: InstanceWriteBackRequest): Promise<InstanceWriteBackSummary> {
  if (!options.withWriteAccess) throw new IntegrationError('SYNC_HOST_WRITE_OWNERSHIP_UNAVAILABLE',
    '宿主 adapter 尚未提供经核验的独占写入协议，对齐已阻止，实例文件未改写。', 409);
  return options.withWriteAccess(() => writeBackWithAccess(options, request));
}

async function writeBackWithAccess(options: InstanceWriteBackOptions, request: InstanceWriteBackRequest): Promise<InstanceWriteBackSummary> {
  const { selection } = options.selectionFor(request.instanceId);
  const memberships = await options.memberships();
  const names = await options.workspaceNames();
  const selected = (workspaceId: LogicalWorkspaceId | null): boolean => selection.kind === 'all'
    || (workspaceId === null ? selection.includeUnassigned : selection.workspaceIds.includes(workspaceId));
  const projection = await options.loadProjection(writeBackRunIdentity(request.instanceId, request.profileId));
  const archived = await readArchivedSessions(request.instanceHome);
  const archiveChanges = projection.sessions.filter(item => selected(item.workspaceId)).map(item => ({
    nativeSessionId: String(v3NativeSessionId(item.session.id)), archived: item.session.archivedAt !== null,
  })).filter(item => archived.has(item.nativeSessionId) !== item.archived);
  if (archiveChanges.length > 0 && !options.synchronizeArchived) throw new IntegrationError('SYNC_HOST_ARCHIVE_UNAVAILABLE',
    '宿主 adapter 尚未提供归档状态恢复协议，对齐未执行。');

  // One local folder per selected bucket, created once and reused afterwards. A projected session's
  // `cwd` becomes that folder, so the host's own membership rule (cwd must resolve to the registered
  // workspace path) can hold for it. A bucket the instance already owns a workspace for keeps that
  // workspace's path: reusing it is what the operator asked for, and it is also what keeps the
  // instance's own sessions where the instance put them.
  const registered = await readRegisteredWorkspacePaths(request.instanceHome);
  const folderFor = new Map<string, string>();
  const known = new Map((await readWorkspaceMappings(options.stateRoot, request.instanceId)).map(item => [item.workspaceId, item]));
  const mapped = mapWorkspaceFolders({ workspaceRoot: options.workspaceRoot, registered,
    verifiedPaths: new Map([...verifiedWorkspacePaths(projection, request.instanceId, registered),
      ...[...known].map(([id, item]) => [id, item.path] as const)]),
    buckets: [...names].map(([workspaceId, name]) => ({ workspaceId, name })) })
    .filter(folder => selected(folder.workspaceId as LogicalWorkspaceId)).map(folder => known.get(folder.workspaceId) ?? folder);
  for (const folder of mapped) {
    if (!folder.owned) await mkdir(folder.path, { recursive: true });
    folderFor.set(folder.workspaceId, folder.path);
  }

  const journal: string[] = [];
  const failures: WriteBackFailures = [];
  const result = await writeBackProjectionToInstance({
    ...(options.withNativeLocks ? { withNativeLocks: options.withNativeLocks } : {}),
    ...(options.bindIdentity ? { bindIdentity: options.bindIdentity } : {}),
    projection,
    sessionsRoot: request.sessionsRoot,
    stateRoot: options.stateRoot,
    instanceId: request.instanceId,
    backupRoot: join(options.backupRoot, request.instanceId, new Date().toISOString().replaceAll(':', '-')),
    inScope: session => selected(memberships.get(session.id) ?? null),
    archived: session => session.archivedAt !== null,
    journal: async entry => { journal.push(JSON.stringify({ at: new Date().toISOString(), instanceId: request.instanceId, ...entry })); },
    materialize: createAdapterMaterializer(failures, folderFor, options.pluginData),
    codec: adapter.nativeSessionCodec,
  });
  if (journal.length > 0) {
    await mkdir(join(options.journalPath, '..'), { recursive: true });
    await appendFile(options.journalPath, `${journal.join('\n')}\n`, 'utf8');
  }
  if (archiveChanges.length > 0) {
    await options.synchronizeArchived!(archiveChanges);
    const actual = await readArchivedSessions(request.instanceHome);
    if (archiveChanges.some(item => actual.has(item.nativeSessionId) !== item.archived))
      throw new IntegrationError('SYNC_HOST_ARCHIVE_UNVERIFIED', '宿主归档回执与实际状态不一致，对齐未完成。');
  }
  if (failures.length === 0) await saveWorkspaceMappings(options.stateRoot, request.instanceId, mapped);
  return { written: result.receipt.applied.filter(entry => entry.action === 'write').length,
    unchanged: result.plan.entries.length - result.receipt.applied.length,
    skippedOutOfScope: result.skippedOutOfScope.length,
    failures: failures.map(failure => `${failure.logicalSessionId}: ${failure.message}`),
    workspaceFolders: [...folderFor.values()] };
}

/**
 * The default materialisation: the adapter turns canonical events into exactly the payload the
 * instance would have written itself, so the instance reads them with no special case.
 *
 * One session the adapter refuses (a canonical row whose native payload does not restore) is
 * recorded in `failures` and the rest still go out: one damaged session must not keep a whole
 * workspace out of the instance, and the file it would have overwritten stays untouched.
 *
 * `folders` maps a Maintenance bucket to the local folder the instance owns it under. The projected
 * session's own `projectRoot` is a fact about the *source* machine, so it is replaced by that folder:
 * the host resolves a session's `cwd` and requires it to equal the registered workspace path, which
 * is the folder we just created for the bucket.
 */
export function createAdapterMaterializer(failures: WriteBackFailures = [], folders: ReadonlyMap<string, string> = new Map(), pluginData?: PluginDataMappingSession):
(input: CanonicalProjectionInput) => Promise<readonly { readonly nativeSessionId: string; readonly payload: never }[]> {
  return async input => {
    const captured = new Map<string, unknown>();
    for (const session of input.sessions) {
      const folder = session.workspaceId === null ? undefined : folders.get(String(session.workspaceId));
      const projected = folder === undefined ? session : { ...session, projectRoot: folder };
      try {
        await adapter.materialize({ ...input, sessions: [projected] }, {
          writeWorkspace: async () => undefined,
          writeSession: async (nativeSessionId: string, payload: unknown) => {
            const filtered = pluginData ? await filterNativePluginData(payload as never, async event => {
              const canonical = session.events.find(item => item.extensions.nativeFormatVersion === 3
                && ((item.extensions.nativeProjectionEvent ?? item.rawPayload) as { seq?: number } | null)?.seq === event.seq);
              const namespace = typeof canonical?.extensions.extensionNamespace === 'string' ? canonical.extensions.extensionNamespace
                : gptCompatExtensionAdapter.nativeEvents?.types.has(event.type) ? gptCompatExtensionAdapter.namespace : undefined;
              if (!namespace) return event;
              const result = await pluginData.map({ namespace, dataType: event.type,
                recordId: canonical?.id ?? `${session.session.id}/${event.type}/${event.seq}`, value: event as never },
                { endpointId: input.run.instanceId, sessionId: nativeSessionId,
                  context: { cwd: (payload as { header: { cwd: string } }).header.cwd } });
              return result.status === 'mapped' && result.placement.kind === 'host-event' ? result.placement.value as never : null;
            }) : payload;
            captured.set(nativeSessionId, filtered);
          },
        } as never);
      } catch (error) {
        failures.push({ logicalSessionId: String(session.session.id), message: error instanceof Error ? error.message : '无法还原为实例会话' });
      }
    }
    return [...captured].map(([nativeSessionId, payload]) => ({ nativeSessionId, payload: payload as never }));
  };
}
