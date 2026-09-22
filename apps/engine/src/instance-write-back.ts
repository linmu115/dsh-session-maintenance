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
  /** The instance's saved range, read from the same table the board writes. */
  readonly selectionFor: (instanceId: string) => { readonly revision: number; readonly selection:
    | { readonly kind: 'all' }
    | { readonly kind: 'ids'; readonly workspaceIds: readonly string[]; readonly includeUnassigned: boolean } };
  readonly memberships: () => Promise<ReadonlyMap<string, LogicalWorkspaceId | null>>;
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

export async function writeBackInstanceWorkspaces(options: InstanceWriteBackOptions, request: InstanceWriteBackRequest): Promise<InstanceWriteBackSummary> {
  const { selection } = options.selectionFor(request.instanceId);
  const memberships = await options.memberships();
  const selected = (workspaceId: LogicalWorkspaceId | null): boolean => selection.kind === 'all'
    || (workspaceId === null ? selection.includeUnassigned : selection.workspaceIds.includes(workspaceId));
  const projection = await options.loadProjection(writeBackRunIdentity(request.instanceId, request.profileId));
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
    materialize: createAdapterMaterializer(failures),
    codec: v3NativeSessionCodec,
  });
  if (journal.length > 0) {
    await mkdir(join(options.journalPath, '..'), { recursive: true });
    await appendFile(options.journalPath, `${journal.join('\n')}\n`, 'utf8');
  }
  return { written: result.receipt.applied.filter(entry => entry.action === 'write').length,
    unchanged: result.plan.entries.length - result.receipt.applied.length,
    skippedOutOfScope: result.skippedOutOfScope.length,
    failures: failures.map(failure => `${failure.logicalSessionId}: ${failure.message}`) };
}

/**
 * The default materialisation: the adapter turns canonical events into exactly the payload the
 * instance would have written itself, so the instance reads them with no special case.
 *
 * One session the adapter refuses (a canonical row whose native payload does not restore) is
 * recorded in `failures` and the rest still go out: one damaged session must not keep a whole
 * workspace out of the instance, and the file it would have overwritten stays untouched.
 */
export function createAdapterMaterializer(failures: WriteBackFailures = []): (input: CanonicalProjectionInput) => Promise<readonly { readonly nativeSessionId: string; readonly payload: never }[]> {
  return async input => {
    const captured = new Map<string, unknown>();
    for (const session of input.sessions) {
      try {
        await materializeV3({ ...input, sessions: [session] }, {
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
