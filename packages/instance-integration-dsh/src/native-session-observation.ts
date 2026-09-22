import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonValue, NativeSessionCodec } from '@linmu/dsh-session-contracts';
import { nativeSessionTarget, type NativeOverwriteSession } from './native-session-overwrite.js';

/**
 * What the instance's session tree actually holds right now, before anything is written.
 *
 * The instance's own host refuses to start when one session id appears under two project
 * directories (`duplicate JSONL session id ... appears in multiple project directories`), and it
 * decides that by enumerating *directories*, not by comparing content. The Engine is the only
 * writer that can create such a pair, because it is the only writer that moves a session from the
 * project directory its `cwd` used to name to the mapped folder its `cwd` now names. So before a
 * write-back the Engine has to look at the whole sessions root, not only at the file it plans to
 * touch: a copy left behind in the old project directory is a boot failure waiting to happen.
 *
 * Two facts are collected per planned session:
 *
 * - `present`: the target session directory already holds a readable artifact. An *empty* file is
 *   not content the host reads (it has no header, so the host skips it), which is exactly why a
 *   file must be re-written when only a zero-byte placeholder survives.
 * - `copies`: the same session id also exists under other project directories. Those are the files
 *   that have to be retired once the intended content is in place.
 */
export interface NativeSessionObservation {
  /** Target `relativePath` → the instance already stores non-empty content there. */
  readonly present: ReadonlySet<string>;
  /** Paths whose decoded artifact matches the intended complete payload. */
  readonly matching: ReadonlySet<string>;
  /** Target `relativePath` → documents under other project directories holding the same session. */
  readonly copies: ReadonlyMap<string, readonly string[]>;
}

/** The artifact names the host reads inside one session directory. */
const SESSION_ARTIFACT = /^session\.v3\.jsonl(?:\.zstd)?$/u;

/**
 * Observe the instance's sessions root for the sessions about to be written.
 *
 * Nothing is assumed about the tree: every project directory is listed, so a session that was
 * written before the workspace mapping existed is found wherever it lies.
 */
export async function observeNativeSessionCopies(input: {
  readonly sessionsRoot: string;
  readonly sessions: readonly NativeOverwriteSession[];
  readonly codec?: NativeSessionCodec;
}): Promise<NativeSessionObservation> {
  const projectDirectories = (await readdir(input.sessionsRoot, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory()).map(entry => entry.name);
  const present = new Set<string>();
  const matching = new Set<string>();
  const copies = new Map<string, readonly string[]>();
  for (const session of input.sessions) {
    const target = nativeSessionTarget(session);
    if (target === null) continue;
    if ((await readArtifacts(join(input.sessionsRoot, target.projectDirectory, target.sessionDirectory))).length > 0) {
      present.add(target.relativePath);
    }
    if (input.codec?.verifyEncoded) {
      try {
        const bytes = await readFile(join(input.sessionsRoot, ...target.relativePath.split('/')));
        input.codec.verifyEncoded(bytes, session.payload, { relativePath: target.relativePath,
          header: (session.payload as { header: JsonValue }).header });
        matching.add(target.relativePath);
      } catch { /* A marker is never evidence that the current bytes still match. */ }
    }
    const elsewhere: string[] = [];
    for (const project of projectDirectories) {
      if (project === target.projectDirectory) continue;
      for (const artifact of await readArtifacts(join(input.sessionsRoot, project, target.sessionDirectory))) {
        elsewhere.push(`${project}/${target.sessionDirectory}/${artifact}`);
      }
    }
    if (elsewhere.length > 0) copies.set(target.relativePath, elsewhere);
  }
  return { present, copies, matching };
}

/** The artifacts in one session directory that actually carry content. */
async function readArtifacts(directory: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !SESSION_ARTIFACT.test(entry.name)) continue;
    const information = await stat(join(directory, entry.name)).catch(() => undefined);
    if (information !== undefined && information.size > 0) found.push(entry.name);
  }
  return found;
}
