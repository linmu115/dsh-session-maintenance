import type { SessionListSnapshot } from "./context.js";

/**
 * The instance side reporting its own archive/delete changes to the Engine.
 *
 * The direction and its timing are the operator's rule, not a design choice made here:
 *
 *   * while the Engine is **running**, the instance is the authority — a session it archives or
 *     deletes is written onto the same source session;
 *   * while the Engine is **stopped**, nothing is sent: the next start overwrites the mapped
 *     workspaces from the source, so an instance-side change made in that window is not an input;
 *   * both directions stay inside the **instance's own bound workspaces**: a session the instance has
 *     not mapped is never pushed, because the Engine would only have to refuse it.
 *
 * Detection is a comparison of two snapshots, because the host exposes no archive/delete event: the
 * sidebar's own list (which carries `archived`) is diffed against the previous observation. That
 * previous observation is deliberately memory-only — a restart must not turn "the source overwrote
 * this" into "the user deleted this".
 */
export interface ObservedSession {
  readonly sessionId: string;
  readonly archived: boolean;
}

export interface SyncIntent {
  readonly kind: "archive" | "delete";
  readonly sessionId: string;
}

/** What the previous observation knew, so the next diff can tell a change from a first sight. */
export type SessionObservation = ReadonlyMap<string, ObservedSession>;

/** Read the host's own list as plain observations. The list is an array of sessions in some builds. */
export function observeSessions(snapshot: SessionListSnapshot): SessionObservation {
  const observed = new Map<string, ObservedSession>();
  const source = snapshot as unknown as { readonly items?: readonly unknown[] };
  const rows: readonly unknown[] = Array.isArray(snapshot) ? snapshot as readonly unknown[] : source.items ?? [];
  for (const row of rows) {
    const session = row as { readonly id?: unknown; readonly sessionId?: unknown; readonly archived?: unknown };
    const id = String(session.id ?? session.sessionId ?? "");
    if (id.length === 0) continue;
    const byId = Array.isArray(snapshot) ? undefined : snapshot.byId?.[id];
    observed.set(id, { sessionId: id, archived: byId?.archived === true || session.archived === true });
  }
  return observed;
}

/**
 * What changed between two observations, as intents to report.
 *
 * A session that appears is a new local session, which the source learns about through its own
 * import path rather than through this report, so it is not an intent. A session that disappears was
 * deleted in the instance; one whose `archived` flipped was archived or restored.
 */
export function sessionSyncIntents(previous: SessionObservation, current: SessionObservation): readonly SyncIntent[] {
  const intents: SyncIntent[] = [];
  for (const [id, before] of previous) {
    const after = current.get(id);
    if (after === undefined) intents.push({ kind: "delete", sessionId: id });
    else if (after.archived !== before.archived) intents.push({ kind: "archive", sessionId: id });
  }
  return intents;
}

export interface SessionChangeReporterInput {
  /** Only while the Engine is reachable; the caller decides, this only asks. */
  readonly engineReady: () => Promise<boolean>;
  /** Whether this instance has mapped the session's workspace; unmapped sessions are never pushed. */
  readonly mapped: (sessionId: string) => Promise<boolean>;
  readonly report: (intent: SyncIntent) => Promise<string>;
  readonly onFeedback: (message: string) => void;
}

/**
 * Report changed sessions, one at a time, and only the ones this instance owns.
 *
 * Failures are reported, never thrown: this runs off the host's own list updates, and an exception
 * there would surface as a broken sidebar rather than as a sync problem the operator can read.
 */
export async function reportSessionChanges(input: SessionChangeReporterInput, intents: readonly SyncIntent[]): Promise<number> {
  if (intents.length === 0) return 0;
  if (!(await input.engineReady().catch(() => false))) return 0;
  let reported = 0;
  for (const intent of intents) {
    if (!(await input.mapped(intent.sessionId).catch(() => false))) continue;
    try {
      input.onFeedback(await input.report(intent));
      reported += 1;
    } catch (error) {
      input.onFeedback(error instanceof Error ? error.message : "无法把实例侧的会话变化同步回真源");
    }
  }
  return reported;
}
