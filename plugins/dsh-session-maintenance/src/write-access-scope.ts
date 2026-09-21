/**
 * The write gate, scoped to what this instance actually synchronises.
 *
 * The gate exists for one situation: a session that Maintenance has taken over
 * and that lies inside the run's frozen synchronisation scope must not be written
 * while the Engine is unreachable, because the Engine is the side that owns that
 * session's canonical history. Everything else has to keep working exactly as it
 * did before Maintenance existed — an instance nobody has taken over, or a
 * workspace the operator never joined, writes freely and is never blocked by a
 * missing Engine.
 *
 * That is deliberately not the same question as "is the Engine reachable?". An
 * instance with no Engine at all is the normal case for this product, so an
 * unreachable Engine must never make an instance unusable.
 */

/** What the gate needs to know about the write that is being attempted. */
export interface WriteTarget {
  /** The workspace the session belongs to, when the caller knows it. */
  readonly workspaceId?: string | undefined;
  readonly logicalSessionId?: string | undefined;
}

/**
 * Whether a target may be written.
 *
 * `unknown` is a real answer rather than a failure: it means this instance
 * cannot tell that the write belongs to a synchronised, taken-over session, and
 * the gate then stays out of the way.
 */
export type WriteScopeDecision = "gated" | "open";

export interface WriteScopePort {
  /** The scope frozen when the current run was prepared; never re-read per write. */
  decisionFor(target: WriteTarget): WriteScopeDecision;
}

/**
 * A scope that has frozen nothing, used when this instance was not taken over.
 *
 * It is the honest default: without a taken-over run there is no frozen scope,
 * so there is nothing the gate may hold back.
 */
export const openWriteScope: WriteScopePort = { decisionFor: () => "open" };

/**
 * The frozen scope of one taken-over run.
 *
 * Membership is captured once, when the run is attached, and never recomputed:
 * a scope that widened later must not retroactively relax a gate that was
 * already in force, and a scope that narrowed must not retroactively block
 * writes the run never admitted.
 */
export class FrozenWriteScope implements WriteScopePort {
  private readonly workspaceIds: ReadonlySet<string>;
  private readonly sessionIds: ReadonlySet<string>;

  constructor(input: { readonly workspaceIds: readonly (string | null)[]; readonly includeUnassigned: boolean;
    readonly logicalSessionIds?: readonly string[] }) {
    this.workspaceIds = new Set(input.workspaceIds.filter((id): id is string => typeof id === "string"));
    this.includeUnassigned = input.includeUnassigned;
    this.sessionIds = new Set(input.logicalSessionIds ?? []);
  }

  private readonly includeUnassigned: boolean;

  decisionFor(target: WriteTarget): WriteScopeDecision {
    if (target.logicalSessionId !== undefined && this.sessionIds.has(target.logicalSessionId)) return "gated";
    if (target.workspaceId === undefined) return this.includeUnassigned ? "gated" : "open";
    return this.workspaceIds.has(target.workspaceId) ? "gated" : "open";
  }
}

export interface ScopedWriteAccessOptions {
  /** The taken-over run's engine-facing readiness checks; only consulted when the scope says so. */
  readonly assertWritable: () => Promise<void>;
  readonly scope: WriteScopePort;
  /** Reported when a target cannot be identified, so the behaviour is visible rather than silent. */
  readonly onUndecidable?: (target: WriteTarget) => void;
}

/**
 * The write gate the host sees.
 *
 * A target outside the frozen scope is admitted immediately and the Engine is
 * never consulted, so an ordinary session in an ordinary workspace cannot be
 * broken by this plugin. A target inside the scope is admitted only when the
 * taken-over run is ready, which is the existing behaviour, unchanged.
 */
export class ScopedSessionWriteAccess {
  readonly protocolVersion = 1;

  constructor(private readonly options: ScopedWriteAccessOptions) {}

  /** What the gate would decide, for diagnostics and the settings surface. */
  decisionFor(target: WriteTarget): WriteScopeDecision { return this.options.scope.decisionFor(target); }

  async assertWritable(target: WriteTarget = {}): Promise<void> {
    if (this.options.scope.decisionFor(target) === "open") return;
    if (target.workspaceId === undefined && target.logicalSessionId === undefined) {
      // The gate cannot tell which session this is; it reports that rather than
      // guessing, because guessing wrong here is what blocks an instance.
      this.options.onUndecidable?.(target);
      return;
    }
    await this.options.assertWritable();
  }
}

/**
 * The session identity a host hook is talking about.
 *
 * Host payload shapes differ between versions, so this reads the fields that
 * name a session or workspace and otherwise reports nothing: an identity this
 * build does not understand must lead to "not gated", never to a blocked write.
 */
export function writeTargetOf(payload: unknown): WriteTarget {
  if (typeof payload !== "object" || payload === null) return {};
  const record = payload as { readonly session?: unknown; readonly workspaceId?: unknown;
    readonly sessionId?: unknown; readonly logicalSessionId?: unknown };
  const session = typeof record.session === "object" && record.session !== null
    ? record.session as { readonly id?: unknown; readonly workspaceId?: unknown } : undefined;
  const pick = (...values: readonly unknown[]): string | undefined =>
    values.find((value): value is string => typeof value === "string" && value.length > 0);
  const workspaceId = pick(record.workspaceId, session?.workspaceId);
  const logicalSessionId = pick(record.logicalSessionId, session?.id, record.sessionId);
  return { ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(logicalSessionId === undefined ? {} : { logicalSessionId }) };
}
