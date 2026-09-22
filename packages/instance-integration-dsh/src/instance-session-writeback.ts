import { createHash } from 'node:crypto';
import type { CanonicalProjectionInput, JsonValue, NativeSessionId, ProjectionWriter } from '@linmu/dsh-session-contracts';
import { v3NativeSessionId } from '@linmu/dsh-session-adapter-0-1-5';
import { adapter } from '@linmu/dsh-session-extension-gpt-compat';
import {
  applyNativeOverwrite, planNativeOverwrite, readArchiveMarker,
  type NativeOverwritePlan, type NativeOverwriteReceipt, type NativeOverwriteSession, type NativeOverwriteState,
} from './native-session-overwrite.js';
import { observeNativeSessionCopies } from './native-session-observation.js';

/**
 * The whole write-back: the run's frozen scope → logical sessions → native
 * payloads → the instance's own session directory.
 *
 * Every step is an existing implementation. The scope is the one
 * `policyForRun` froze when the run was prepared, so a workspace outside it can
 * never reach the instance; the payloads come from the adapter's own
 * `materializeV3`, so the bytes are the ones the instance itself would write.
 * The Engine only decides *where* they go, which is the instance's layout.
 */

/** What the adapter hands back for one session: the payload the codec encodes. */
export interface MaterializedNativeSession {
  readonly nativeSessionId: string;
  readonly payload: JsonValue;
}

export interface InstanceWriteBackResult {
  readonly plan: NativeOverwritePlan;
  readonly receipt: NativeOverwriteReceipt;
  /** Sessions the projection contained but the scope excluded, reported rather than written. */
  readonly skippedOutOfScope: readonly string[];
}

/**
 * Materialise one canonical projection into native payloads.
 *
 * `materializeV3` writes through a `ProjectionWriter`, so this is the smallest
 * adapter that captures the session payloads instead of persisting them; the
 * manifest it returns is the adapter's, not one invented here.
 */
export async function materializeNativeSessions(input: CanonicalProjectionInput): Promise<readonly MaterializedNativeSession[]> {
  const captured = new Map<string, JsonValue>();
  const writer: ProjectionWriter = {
    writeWorkspace: async () => undefined,
    writeSession: async (nativeSessionId: NativeSessionId, payload: JsonValue) => { captured.set(String(nativeSessionId), payload); },
  };
  await adapter.materialize(input, writer);
  return [...captured].map(([nativeSessionId, payload]) => ({ nativeSessionId, payload }));
}

/**
 * The revision a session is at, as the instance would tell them apart.
 *
 * It is derived from the session identity and its head version, not from the
 * payload bytes: a retry of the same head has to look unchanged, while a new
 * head must always look changed. Random or time-based values would rewrite the
 * instance on every start.
 */
export function sessionRevision(payload: JsonValue): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

/**
 * What the Engine last recorded for these sessions, from its own state root.
 *
 * Both facts come from the Engine's own record of its last write, because it
 * cannot learn either of them from the instance's layout: the revision it wrote,
 * and whether the true source had the session archived. A session with no record
 * has never been written, so the first write always goes out.
 */
export async function readNativeOverwriteState(input: {
  readonly stateRoot: string;
  readonly instanceId: string;
  readonly sessions: readonly NativeOverwriteSession[];
  readonly relativePathFor: (session: NativeOverwriteSession) => string | null;
}): Promise<NativeOverwriteState> {
  const revisions = new Map<string, string>();
  const archived = new Map<string, boolean>();
  for (const session of input.sessions) {
    const relativePath = input.relativePathFor(session);
    if (relativePath === null) continue;
    const marker = await readArchiveMarker(input.stateRoot, input.instanceId, relativePath);
    if (marker === undefined) continue;
    revisions.set(relativePath, marker.revision);
    archived.set(relativePath, marker.archived);
  }
  return { revisions, archived };
}

export interface WriteBackInput {
  readonly bindIdentity?: (nativeSessionId: string, logicalSessionId: string, checkOnly: boolean) => Promise<void>;
  readonly projection: CanonicalProjectionInput;
  readonly sessionsRoot: string;
  readonly stateRoot: string;
  readonly instanceId: string;
  readonly backupRoot: string;
  /** Which sessions the run's frozen scope admits; everything else is reported and skipped. */
  readonly inScope: (session: { readonly id: string; readonly workspaceId: string | null }) => boolean;
  /** Whether the true source has the session archived; the instance must match. */
  readonly archived: (session: { readonly id: string; readonly archivedAt: string | null }) => boolean;
  readonly journal: (entry: import('./native-session-overwrite.js').NativeOverwriteJournalEntry) => Promise<void>;
  readonly materialize?: (input: CanonicalProjectionInput) => Promise<readonly MaterializedNativeSession[]>;
  readonly codec?: import('@linmu/dsh-session-contracts').NativeSessionCodec;
}

/**
 * Write the frozen scope back into the instance's session directory.
 *
 * The scope filter runs before anything is materialised, so a session outside it
 * is never even turned into bytes. The plan is built from what the Engine wrote
 * last time, so an unchanged run writes nothing at all.
 */
export async function writeBackProjectionToInstance(input: WriteBackInput): Promise<InstanceWriteBackResult> {
  const admitted = input.projection.sessions.filter(session => input.inScope({ id: session.session.id, workspaceId: session.workspaceId }));
  const skippedOutOfScope = input.projection.sessions
    .filter(session => !input.inScope({ id: session.session.id, workspaceId: session.workspaceId }))
    .map(session => session.session.id);
  const scoped: CanonicalProjectionInput = { ...input.projection, sessions: admitted };
  const materialized = await (input.materialize ?? materializeNativeSessions)(scoped);
  // The adapter names each native session from its logical parent, so the payload
  // is tied back to the canonical session it came from through the adapter's own
  // rule rather than a mapping invented here.
  const sessions: NativeOverwriteSession[] = materialized.flatMap(item => {
    const canonical = admitted.find(session => String(v3NativeSessionId(session.session.id)) === item.nativeSessionId);
    if (canonical === undefined) return [];
    return [{ nativeSessionId: item.nativeSessionId, payload: item.payload,
      revision: sessionRevision(item.payload),
      archived: input.archived({ id: canonical.session.id, archivedAt: canonical.session.archivedAt ?? null }) }];
  });
  const identities = admitted.filter(item => sessions.some(s => s.nativeSessionId === String(v3NativeSessionId(item.session.id))));
  for (const item of identities) await input.bindIdentity?.(String(v3NativeSessionId(item.session.id)), String(item.session.id), true);
  const { nativeSessionTarget } = await import('./native-session-overwrite.js');
  const state = await readNativeOverwriteState({ stateRoot: input.stateRoot, instanceId: input.instanceId, sessions,
    relativePathFor: session => nativeSessionTarget(session)?.relativePath ?? null });
  // The instance's tree is read before it is written. Its own record of a previous write is not
  // proof that the content is still there, and a copy left in the project directory a session's
  // `cwd` used to name is what makes the host refuse to start.
  const observed = await observeNativeSessionCopies({ sessionsRoot: input.sessionsRoot, sessions, codec: input.codec ?? adapter.nativeSessionCodec });
  const verifiedRevisions = new Map(state.revisions);
  for (const session of sessions) {
    const path = nativeSessionTarget(session)?.relativePath;
    if (!path) continue;
    if (observed.matching.has(path)) verifiedRevisions.set(path, session.revision);
    else verifiedRevisions.delete(path);
  }
  const plan = planNativeOverwrite({ sessionsRoot: input.sessionsRoot, sessions,
    state: { ...state, revisions: verifiedRevisions, present: observed.present, copies: observed.copies } });
  const receipt = await applyNativeOverwrite({ sessionsRoot: input.sessionsRoot, sessions, plan,
    journal: input.journal, backupRoot: input.backupRoot, stateRoot: input.stateRoot, instanceId: input.instanceId,
    duplicates: observed.copies, codec: input.codec ?? adapter.nativeSessionCodec });
  // Also repair already-materialized identities. A successful unchanged pass is valid evidence.
  for (const item of identities) await input.bindIdentity?.(String(v3NativeSessionId(item.session.id)), String(item.session.id), false);
  return { plan, receipt, skippedOutOfScope };
}
