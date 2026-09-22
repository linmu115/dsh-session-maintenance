import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NativeSessionCodec, NativeSessionFileDescription, JsonValue } from '@linmu/dsh-session-contracts';
import { v3NativeProjectKey, v3NativeSessionCodec } from '@linmu/dsh-session-adapter-0-1-5';

/**
 * Writing the true source back into the instance's own session directory.
 *
 * The instance keeps one directory per session
 * (`<DSH_HOME>/sessions/<project>/<session-id>/session.v3.jsonl.zstd`). Putting a
 * `session*.jsonl(.zstd)` straight into the project directory would be read as
 * the old flat layout and rejected by the host, so the path is never built by
 * hand here: the adapter's own codec derives it, which is also what keeps the
 * encoding identical to what the instance itself writes.
 *
 * A refresh in the instance's Web UI is enough to see the result, because the
 * host lists session directories on demand rather than indexing them at start.
 */

/** One session the Engine intends to write back into the instance. */
export interface NativeOverwriteSession {
  readonly nativeSessionId: string;
  /** The logical session's canonical content, in the adapter's native payload shape. */
  readonly payload: JsonValue;
  /**
   * The revision the payload was materialised from. Only a revision differs from
   * the instance's own copy does the Engine write; this is what keeps a start
   * with nothing to do from rewriting every session.
   */
  readonly revision: string;
  /** Whether the true source considers this session archived; the instance must agree. */
  readonly archived: boolean;
}

export interface NativeOverwritePlanEntry {
  readonly nativeSessionId: string;
  /** Relative to the instance's sessions root; always a session directory, never the project directory. */
  readonly relativePath: string;
  readonly action: 'write' | 'restore-unarchived' | 'archive' | 'unchanged';
  /** Deterministic: the same intended change always names the same operation. */
  readonly operationId: string;
}

export interface NativeOverwritePlan {
  readonly sessionsRoot: string;
  readonly entries: readonly NativeOverwritePlanEntry[];
  /** Only the entries that would change something. */
  readonly changed: readonly NativeOverwritePlanEntry[];
}

/** What the instance's directory already contains, as observed (never assumed). */
export interface NativeOverwriteState {
  /** `relativePath` → the revision previously written there. */
  readonly revisions: ReadonlyMap<string, string>;
  /** `relativePath` → whether the instance currently has that session archived. */
  readonly archived: ReadonlyMap<string, boolean>;
}

/** Where the Engine keeps what it wrote, so a later run can tell unchanged from changed. */
export interface NativeOverwriteJournalEntry {
  readonly relativePath: string;
  readonly revision: string;
  readonly archived: boolean;
  /** The bytes that were replaced, so the write is reversible. */
  readonly backupPath: string | null;
}



/**
 * The operation name for one intended change.
 *
 * It is derived from the change itself rather than generated, so replaying the
 * same intent produces the same operation instead of a second version. A random
 * id here would make every retry look like new work.
 */
export function overwriteOperationId(nativeSessionId: string, revision: string, action: string): string {
  return `native-overwrite-${createHash('sha256').update(`${nativeSessionId}\u0000${revision}\u0000${action}`).digest('hex').slice(0, 32)}`;
}

function targetPath(codec: NativeSessionCodec, sessionsRoot: string, description: NativeSessionFileDescription): string {
  return join(sessionsRoot, ...description.relativePath.split('/'));
}

/**
 * Decide what the instance's directory needs, without writing anything.
 *
 * Only sessions handed in are considered, so the caller's frozen run scope is the
 * only thing that can reach the instance: a session outside it is not looked at,
 * let alone written. Once the application starts, each entry leaves the
 * directory either exactly as the true source describes it, or untouched.
 */
export function planNativeOverwrite(input: {
  readonly sessionsRoot: string;
  readonly sessions: readonly NativeOverwriteSession[];
  readonly state: NativeOverwriteState;
}): NativeOverwritePlan {
  const entries: NativeOverwritePlanEntry[] = [];
  for (const session of input.sessions) {
    // A session without a derivable path is not written at all: guessing a layout
    // is exactly what produces the flat layout the host refuses to read.
    const target = nativeSessionTarget(session);
    if (target === null) continue;
    const relativePath = target.relativePath;
    const written = input.state.revisions.get(relativePath);
    const archivedNow = input.state.archived.get(relativePath);
    // Two independent questions. The bytes: a changed payload digest is a write,
    // and an unchanged one is nothing at all. The archive state: it is *not* part
    // of the session bytes, so the only record of it is the Engine's own, and a
    // disagreement there is what makes the recovery symmetric — a session the
    // true source no longer has archived is restored to active.
    const action: NativeOverwritePlanEntry['action'] = written !== session.revision ? 'write'
      : archivedNow !== undefined && archivedNow !== session.archived ? (session.archived ? 'archive' : 'restore-unarchived')
      : 'unchanged';
    entries.push({ nativeSessionId: session.nativeSessionId, relativePath, action,
      operationId: overwriteOperationId(session.nativeSessionId, session.revision, action) });
  }
  return { sessionsRoot: input.sessionsRoot, entries, changed: entries.filter(entry => entry.action !== 'unchanged') };
}

/**
 * Where one session belongs inside the instance's sessions root.
 *
 * The codec derives the session directory from the persistence root it is given,
 * so the Engine hands it the *project* directory the instance already uses for
 * that workspace and lets the codec name the session inside it. Building the
 * path without the codec is what would produce the flat layout the host rejects.
 */
export interface NativeSessionTarget {
  readonly projectDirectory: string;
  readonly sessionDirectory: string;
  /** Document-style path below the sessions root, so both platforms agree. */
  readonly relativePath: string;
}

/** Where one session belongs inside the instance's sessions root. */
export function nativeSessionTarget(session: Pick<NativeOverwriteSession, 'nativeSessionId' | 'payload'>): NativeSessionTarget | null {
  const header = (session.payload as { header?: unknown }).header;
  if (typeof header !== 'object' || header === null) return null;
  const id = (header as { id?: unknown }).id;
  if (typeof id !== 'string' || id.length === 0) return null;
  const projectDirectory = nativeProjectDirectory((header as { cwd?: unknown }).cwd);
  const sessionDirectory = nativeSessionSegment(id);
  return { projectDirectory, sessionDirectory,
    relativePath: `${projectDirectory}/${sessionDirectory}/session.v3.jsonl.zstd` };
}

/**
 * The adapter's own rule for the project directory name.
 *
 * The project directory is the one the *instance* already uses for that
 * workspace — reading it out of the instance's own layout is what keeps both
 * sides on the same directory. The platform's rule is shared here so a plan can
 * be built before anything is written.
 */
export function nativeProjectDirectory(cwd: unknown): string {
  // One rule, one implementation: the adapter owns the platform layout, and this only adapts its
  // "absent cwd" spelling. A second copy here once drifted from it, and a caller that also applied
  // the project key produced a path one level too deep ("Misplaced native artifact" on read).
  if (typeof cwd !== 'string' || cwd.length === 0) return '_no-cwd';
  return v3NativeProjectKey(cwd);
}

/**
 * The session's own directory name.
 *
 * Verified against a real DSH Home: the host uses the raw native session id as
 * the directory name (`session-<uuid>`), with no escaping. Path separators are
 * the only thing that could ever need handling, and a native session id cannot
 * contain one, so the id is used as-is rather than re-encoded into a name the
 * host would not find.
 */
export function nativeSessionSegment(raw: string): string {
  return raw;
}

export interface NativeOverwriteReceipt {
  readonly applied: readonly NativeOverwritePlanEntry[];
  readonly journal: readonly NativeOverwriteJournalEntry[];
}

/**
 * Apply the plan to the instance's own session directory.
 *
 * Every written file is staged next to its target and renamed into place, so the
 * host never observes a half-written session, and the bytes that were there
 * before are kept first: a refresh shows the new content, and the previous one
 * is still recoverable. Sessions whose intended revision is already on disk are
 * left completely alone — that is what keeps a start with nothing to do cheap.
 */
export async function applyNativeOverwrite(input: {
  readonly sessionsRoot: string;
  readonly sessions: readonly NativeOverwriteSession[];
  readonly plan: NativeOverwritePlan;
  readonly journal: (entry: NativeOverwriteJournalEntry) => Promise<void>;
  readonly codec?: NativeSessionCodec;
  readonly backupRoot: string;
  /** The Engine's own state root; the archive marker lives there, not in the instance tree. */
  readonly stateRoot: string;
  readonly instanceId: string;
}): Promise<NativeOverwriteReceipt> {
  const codec = input.codec ?? v3NativeSessionCodec;
  const applied: NativeOverwritePlanEntry[] = [];
  const journal: NativeOverwriteJournalEntry[] = [];
  const bySession = new Map(input.sessions.map(session => [session.nativeSessionId, session]));
  for (const entry of input.plan.changed) {
    const session = bySession.get(entry.nativeSessionId);
    if (session === undefined) continue;
    const metadata = session.payload;
    const planned = nativeSessionTarget(session);
    if (planned === null || planned.relativePath !== entry.relativePath) continue;
    // The description is what `encode` needs: where the file goes and its header.
    // The path itself is the instance's layout, not the adapter's runtime-managed
    // one: `describe` names its own projection directories, which the instance
    // would read as the wrong project. Writing must land where the host looks.
    const description: NativeSessionFileDescription = {
      relativePath: join(...planned.relativePath.split('/').slice(1)),
      header: (metadata as { header: JsonValue }).header,
    };
    const target = localPath(input.sessionsRoot, entry.relativePath);
    if (entry.action === 'write') {
      const bytes = codec.encode(metadata, description);
      codec.verifyEncoded?.(bytes, metadata, description);
      const backupPath = localPath(input.backupRoot, entry.relativePath);
      await mkdir(dirname(backupPath), { recursive: true });
      const previous = await readFile(target).catch(() => undefined);
      if (previous === undefined) await rm(backupPath, { force: true });
      else await writeFile(backupPath, previous);
      await mkdir(dirname(target), { recursive: true });
      const staged = `${target}.${process.pid}.staged`;
      await writeFile(staged, bytes);
      await rename(staged, target);
      const record: NativeOverwriteJournalEntry = { relativePath: entry.relativePath, revision: session.revision,
        archived: session.archived, backupPath: previous === undefined ? null : backupPath };
      journal.push(record);
      await writeArchiveMarker({ stateRoot: input.stateRoot, instanceId: input.instanceId, relativePath: entry.relativePath,
        record: { revision: session.revision, archived: session.archived } });
    } else {
      // A restore changes only the Engine's own record: the host's archive state is
      // the true source's to state, and rewriting the body would be a needless write.
      await writeArchiveMarker({ stateRoot: input.stateRoot, instanceId: input.instanceId, relativePath: entry.relativePath,
        record: { revision: session.revision, archived: session.archived } });
      const record: NativeOverwriteJournalEntry = { relativePath: entry.relativePath, revision: session.revision,
        archived: session.archived, backupPath: null };
      journal.push(record);
    }
    await input.journal(journal[journal.length - 1]!);
    applied.push(entry);
  }
  return { applied, journal };
}

/** Filesystem path for a document-style relative path, on any platform. */
function localPath(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'));
}

/**
 * Where the Engine records what it last wrote for one session.
 *
 * The marker lives under the Engine's own state root, never inside the
 * instance's session tree: that tree belongs to the instance, and leaving a file
 * there that the host does not know about is an unknown risk for no benefit. It
 * carries both facts the next overwrite needs — which revision was written, so an
 * unchanged start writes nothing at all, and whether the true source had it
 * archived, so an archive-only change is still symmetric. The Engine cannot learn
 * either of them from the instance's layout, so it remembers its own decision.
 *
 * DEFERRED, and deliberately not done anywhere yet: the host keeps the
 * *authoritative* archive state itself, in `<DSH_HOME>/storages/workspace.json`
 * at `global.archivedSessionIds` (verified read-only against a real Home, next to
 * a versioned per-session cache under `storages/session_projcache/sessions/`).
 * Restoring a session to unarchived therefore only becomes genuinely visible to
 * the host once that record changes, and writing it is deferred because it is a
 * versioned store the host keeps in step with its own in-memory state, there is
 * no writing API for it, and this Engine is not yet invoked at a point where the
 * instance is stopped. Preconditions before anyone attempts it: the instance is
 * stopped, the store is backed up first, the exact format and whether the
 * projection cache has to move with it are established, and there is a real
 * acceptance check for the outcome. It must not be written as a side effect of
 * another task.
 */
export interface NativeArchiveRecord {
  readonly revision: string;
  readonly archived: boolean;
}

export const NATIVE_ARCHIVE_MARKER_DIRECTORY = 'native-archive-markers';

export function archiveMarkerPath(stateRoot: string, instanceId: string, relativePath: string): string {
  return join(stateRoot, NATIVE_ARCHIVE_MARKER_DIRECTORY, instanceId, ...relativePath.split('/').slice(0, -1)) + '.json';
}

async function writeArchiveMarker(input: { readonly stateRoot: string; readonly instanceId: string;
  readonly relativePath: string; readonly record: NativeArchiveRecord }): Promise<void> {
  const resolved = archiveMarkerPath(input.stateRoot, input.instanceId, input.relativePath);
  await mkdir(dirname(resolved), { recursive: true });
  const staged = `${resolved}.${process.pid}.staged`;
  await writeFile(staged, `${JSON.stringify({ schemaVersion: 1, instanceId: input.instanceId,
    relativePath: input.relativePath, ...input.record })}\n`, 'utf8');
  await rename(staged, resolved);
}

/** Read back what the Engine previously recorded for one session. */
export async function readArchiveMarker(stateRoot: string, instanceId: string, relativePath: string): Promise<NativeArchiveRecord | undefined> {
  const text = await readFile(archiveMarkerPath(stateRoot, instanceId, relativePath), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as { revision?: unknown; archived?: unknown };
    if (typeof parsed.revision !== 'string' || typeof parsed.archived !== 'boolean') return undefined;
    return { revision: parsed.revision, archived: parsed.archived };
  } catch { return undefined; }
}
