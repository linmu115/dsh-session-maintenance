import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CanonicalProjectionInput, LogicalWorkspaceId, ProjectionRun } from '@linmu/dsh-session-contracts';
import { materializeV3, v3NativeSessionCodec } from '@linmu/dsh-session-adapter-0-1-5';
import type { InstanceWriteBackSummary } from './instance-workspace-service.js';
import { writeBackProjectionToInstance } from './instance-session-writeback.js';

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

export async function writeBackInstanceWorkspaces(options: InstanceWriteBackOptions, request: InstanceWriteBackRequest): Promise<InstanceWriteBackSummary> {
  const { selection } = options.selectionFor(request.instanceId);
  const memberships = await options.memberships();
  const names = await options.workspaceNames();
  const selected = (workspaceId: LogicalWorkspaceId | null): boolean => selection.kind === 'all'
    || (workspaceId === null ? selection.includeUnassigned : selection.workspaceIds.includes(workspaceId));
  const projection = await options.loadProjection(writeBackRunIdentity(request.instanceId, request.profileId));

  // One local folder per selected bucket, created once and reused afterwards. A projected session's
  // `cwd` becomes that folder, so the host's own membership rule (cwd must resolve to the registered
  // workspace path) can hold for it.
  const folderFor = new Map<string, string>();
  const claimed = new Map<string, string>();
  for (const workspaceId of new Set(projection.sessions.map(session => session.workspaceId).filter(id => id !== null && selected(id)))) {
    const name = workspaceFolderName(names.get(String(workspaceId)) ?? String(workspaceId), String(workspaceId));
    // Two buckets whose names sanitise to the same folder must not share one: the second one is
    // distinguished by a short stable suffix rather than silently merging two buckets into one.
    const owner = claimed.get(name.toLowerCase());
    const folder = owner === undefined || owner === String(workspaceId)
      ? name : `${name}-${String(workspaceId).slice(-6)}`;
    claimed.set(folder.toLowerCase(), String(workspaceId));
    const path = join(options.workspaceRoot, folder);
    await mkdir(path, { recursive: true });
    folderFor.set(String(workspaceId), path);
  }

  const journal: string[] = [];
  const failures: WriteBackFailures = [];
  const result = await writeBackProjectionToInstance({
    projection,
    sessionsRoot: request.sessionsRoot,
    stateRoot: options.stateRoot,
    instanceId: request.instanceId,
    backupRoot: join(options.backupRoot, request.instanceId, new Date().toISOString().replaceAll(':', '-')),
    inScope: session => selected(memberships.get(session.id) ?? null),
    archived: session => session.archivedAt !== null,
    journal: async entry => { journal.push(JSON.stringify({ at: new Date().toISOString(), instanceId: request.instanceId, ...entry })); },
    materialize: createAdapterMaterializer(failures, folderFor),
    codec: v3NativeSessionCodec,
  });
  if (journal.length > 0) {
    await mkdir(join(options.journalPath, '..'), { recursive: true });
    await appendFile(options.journalPath, `${journal.join('\n')}\n`, 'utf8');
  }
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
export function createAdapterMaterializer(failures: WriteBackFailures = [], folders: ReadonlyMap<string, string> = new Map()):
(input: CanonicalProjectionInput) => Promise<readonly { readonly nativeSessionId: string; readonly payload: never }[]> {
  return async input => {
    const captured = new Map<string, unknown>();
    for (const session of input.sessions) {
      const folder = session.workspaceId === null ? undefined : folders.get(String(session.workspaceId));
      const projected = folder === undefined ? session : { ...session, projectRoot: folder };
      try {
        await materializeV3({ ...input, sessions: [projected] }, {
          writeWorkspace: async () => undefined,
          writeSession: async (nativeSessionId: string, payload: unknown) => { captured.set(nativeSessionId, payload); },
        } as never);
      } catch (error) {
        failures.push({ logicalSessionId: String(session.session.id), message: error instanceof Error ? error.message : '无法还原为实例会话' });
      }
    }
    return [...captured].map(([nativeSessionId, payload]) => ({ nativeSessionId, payload: payload as never }));
  };
}
