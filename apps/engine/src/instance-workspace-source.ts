import { join } from 'node:path';
import type { CanonicalEventV1, NativeSessionArtifact, NativeSessionId } from '@linmu/dsh-session-contracts';
// The adapter already walks exactly this layout and decodes every generation it
// finds; the reusable half is its own space inspector, so the Engine reads the
// instance the same way the projection does rather than with a second reader.
import { inspectV3NativeSpace } from '@linmu/dsh-session-adapter-0-1-5';
import type { JoinedWorkspaceSource, MappedNativeSession } from './workspace-session-mapping.js';


/**
 * Reading a joined workspace's sessions out of the instance.
 *
 * The instance keeps one directory per session under a project directory, and
 * the adapter's own space inspector already walks exactly that layout and
 * decodes every generation it finds. Using it keeps the Engine reading the
 * instance the same way the projection does, instead of a second reader that
 * could disagree about what a session is.
 *
 * Nothing here writes: joining only reads what the workspace already has. The
 * canonical records it produces are Maintenance's own storage.
 */

/** The project directory the instance uses for one workspace path. */
export function instanceProjectDirectory(instanceRoot: string, projectDirectory: string): string {
  return join(instanceRoot, 'sessions', projectDirectory);
}

/**
 * The canonical kind and role for one native row.
 *
 * The canonical store validates both, so they are derived from the row's own
 * type rather than guessed: a row the mapping does not recognise stays
 * `opaque-unknown` instead of being mislabelled as a conversation message, which
 * keeps the original row authoritative through `rawPayload`.
 */
export function canonicalShapeFor(event: unknown): { readonly kind: string; readonly role: string | null } {
  const type = typeof event === 'object' && event !== null ? (event as { type?: unknown }).type : undefined;
  switch (type) {
    case 'user/message': return { kind: 'user-message', role: 'user' };
    case 'assistant/message':
    case 'agent/message': return { kind: 'assistant-message', role: 'assistant' };
    case 'system/message': return { kind: 'system-message', role: 'system' };
    case 'reasoning': return { kind: 'reasoning', role: 'assistant' };
    case 'tool/call': return { kind: 'tool-call', role: 'assistant' };
    case 'tool/result': return { kind: 'tool-result', role: 'tool' };
    case 'annotation': return { kind: 'annotation', role: null };
    case 'sticker': return { kind: 'sticker', role: null };
    case 'attachment': return { kind: 'attachment', role: null };
    case 'system/metadata': return { kind: 'system-metadata', role: null };
    default: return { kind: 'opaque-unknown', role: null };
  }
}

/**
 * The canonical events for one decoded native session.
 *
 * The native rows are kept as `rawPayload`, which is what the adapter's own
 * materialisation reads back when it writes the session out again: the mapping
 * stays lossless because the original row travels with it.
 */
export function canonicalEventsFor(input: {
  readonly artifact: NativeSessionArtifact;
  readonly instanceId: string;
  /** The canonical session these rows belong to; the caller owns that identity rule. */
  readonly logicalSessionId: (nativeSessionId: string) => string;
}): readonly CanonicalEventV1[] {
  const logicalSessionId = input.logicalSessionId(String(input.artifact.nativeSessionId)) as never;
  return input.artifact.events.map((event, index) => {
    const shape = canonicalShapeFor(event);
    return {
      schemaVersion: 1 as const,
      id: `${input.artifact.nativeSessionId}#${index}` as never,
      logicalSessionId,
      sequence: index,
      kind: shape.kind,
      role: shape.role,
      content: {},
      contentDigest: `sha256:native-${input.artifact.nativeSessionId}-${index}`,
      rawPayload: event,
      extensions: { nativeFormatVersion: 3 },
      source: { platform: "dsh", instanceId: input.instanceId, sessionId: String(input.artifact.nativeSessionId),
        eventId: String(index), cursor: String(index) },
    } as unknown as CanonicalEventV1;
  });
}

/**
 * A read-only source over one project directory of the instance.
 *
 * `list` is the directory scan and `read` decodes one session on demand, so a
 * workspace with one unreadable session still maps the rest.
 */
export function createInstanceWorkspaceSource(input: {
  /** The instance's native sessions root (`<DSH_HOME>/sessions`) — the root the adapter walks. */
  readonly sessionsRoot: string;
  /** The project key this source covers, passed in: deriving it from the root would recreate the
   * confusion this argument exists to remove (the key is applied by the layout rule, not by us). */
  readonly projectDirectory: string;
  readonly instanceId: string;
  /** The canonical session identity rule, so imported rows belong to the right session. */
  readonly logicalSessionId: (nativeSessionId: string) => string;
  readonly inspect?: typeof inspectV3NativeSpace;
}): JoinedWorkspaceSource & { readonly projectDirectory: string } {
  const inspect = input.inspect ?? inspectV3NativeSpace;
  return {
    projectDirectory: input.projectDirectory,
    list: async () => (await inspect(input.sessionsRoot)).map(artifact => artifact.nativeSessionId),
    read: async (nativeSessionId: NativeSessionId): Promise<MappedNativeSession> => {
      const artifact = (await inspect(input.sessionsRoot)).find(item => item.nativeSessionId === nativeSessionId);
      if (artifact === undefined) throw new Error(`实例的会话目录中不再有 ${nativeSessionId}`);
      const title = typeof artifact.header === "object" && artifact.header !== null
        && typeof (artifact.header as { title?: unknown }).title === "string"
        ? (artifact.header as { title: string }).title : String(nativeSessionId);
      return { nativeSessionId, title, tags: [], archivedAt: null,
        events: canonicalEventsFor({ artifact, instanceId: input.instanceId, logicalSessionId: input.logicalSessionId }) };
    },
  };
}
