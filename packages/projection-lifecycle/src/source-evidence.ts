import type { AdapterEvidencePort, CanonicalProjectionInput, CanonicalProjectionSource, DshSessionAdapterV1, IncrementalCanonicalProjectionSource } from "@linmu/dsh-session-contracts";

/** The adapter owns format recovery; every projection/revision check sees the same read-only view. */
export function sourceWithEvidence(source: CanonicalProjectionSource, adapter: DshSessionAdapterV1, evidence?: AdapterEvidencePort): CanonicalProjectionSource {
  if (!evidence || !adapter.restoreNativeEvents) return source;
  const restore = adapter.restoreNativeEvents.bind(adapter);
  const project = async (input: CanonicalProjectionInput): Promise<CanonicalProjectionInput> => ({ ...input,
    sessions: await Promise.all(input.sessions.map(async item => ({ ...item, events: await restore(item.events, evidence) }))),
  });
  const incremental = source as Partial<IncrementalCanonicalProjectionSource>;
  return {
    load: async run => project(await source.load(run)),
    ...(source.loadVersionEvents ? { loadVersionEvents: async (id, version) => restore(await source.loadVersionEvents!(id, version), evidence) } satisfies Pick<CanonicalProjectionSource, "loadVersionEvents"> : {}),
    ...(incremental.currentRevision && incremental.listChanges && incremental.loadSessions ? {
      currentRevision: () => incremental.currentRevision!(),
      listChanges: (input: Parameters<IncrementalCanonicalProjectionSource["listChanges"]>[0]) => incremental.listChanges!(input),
      loadSessions: async (...args: Parameters<IncrementalCanonicalProjectionSource["loadSessions"]>) => project(await incremental.loadSessions!(...args)),
    } : {}),
  };
}
