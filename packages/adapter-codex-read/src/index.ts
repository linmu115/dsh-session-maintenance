import type {
  AdapterProbe,
  ExpectedPlatformState,
  NormalizedSession,
  ObservationHint,
  PlatformSessionKey,
  PlatformSessionSummary,
  RegisteredInstance,
  ScanCursor,
  SessionReadAdapter,
  StableObservation,
  UnstableRead,
  VerificationResult,
} from "@linmu/dsh-session-contracts";
import { canonicalJson } from "@linmu/dsh-session-domain";

import { listCodexSessions } from "./catalog.js";
import { normalizeCodexObservation } from "./normalizer.js";
import { probeCodexInstance } from "./probe.js";
import { observeCodexSession, type CodexReadHooks } from "./stable-read.js";
import type { CodexReadStatusEvent } from "./status.js";

export interface CodexReadAdapterOptions {
  readonly fixtureGuard?: (root: string) => void;
  readonly afterRead?: (path: string) => void | Promise<void>;
  /**
   * Structured breakpoint entry for live Codex imports. Consumers can persist
   * these events in their own diagnostic log without coupling this read-only
   * adapter to a projection run.
   */
  readonly onStatus?: (event: CodexReadStatusEvent) => void | Promise<void>;
}

export interface CodexDebugCounters {
  readonly rolloutBodyReads: number;
  readonly rolloutProbeReads: number;
}

function fingerprintSet(fingerprints: ExpectedPlatformState["fingerprints"]): ReadonlySet<string> {
  return new Set(
    fingerprints.map((item) =>
      canonicalJson({
        platform: item.platform,
        instanceId: item.instanceId,
        sessionId: item.sessionId,
        kind: item.kind,
        value: item.value,
      }),
    ),
  );
}

export class CodexReadAdapter implements SessionReadAdapter {
  readonly platform = "codex" as const;
  private readonly options: CodexReadAdapterOptions;
  private bodyReads = 0;
  private probeReads = 0;

  constructor(options: CodexReadAdapterOptions = {}) {
    if (process.env.VITEST !== undefined && options.fixtureGuard === undefined) {
      throw new Error("CodexReadAdapter requires a fixture guard under Vitest");
    }
    this.options = options;
  }

  probe(instance: RegisteredInstance): Promise<AdapterProbe> {
    return probeCodexInstance(instance, this.options.fixtureGuard, () => {
      this.probeReads += 1;
    });
  }

  list(instance: RegisteredInstance, cursor?: ScanCursor): AsyncIterable<PlatformSessionSummary> {
    return listCodexSessions(
      instance,
      cursor,
      this.options.fixtureGuard,
      this.options.onStatus,
    );
  }

  observe(
    instance: RegisteredInstance,
    key: PlatformSessionKey,
    hint?: ObservationHint,
  ): Promise<StableObservation | UnstableRead> {
    const hooks: CodexReadHooks = {
      ...(this.options.fixtureGuard === undefined ? {} : { fixtureGuard: this.options.fixtureGuard }),
      ...(this.options.afterRead === undefined ? {} : { afterRead: this.options.afterRead }),
      ...(this.options.onStatus === undefined ? {} : { onStatus: this.options.onStatus }),
      onBodyRead: () => {
        this.bodyReads += 1;
      },
    };
    return observeCodexSession(instance, key, hint, hooks);
  }

  normalize(observation: StableObservation): Promise<NormalizedSession> {
    return Promise.resolve(normalizeCodexObservation(observation));
  }

  async verify(
    instance: RegisteredInstance,
    key: PlatformSessionKey,
    expected: ExpectedPlatformState,
  ): Promise<VerificationResult> {
    const observation = await this.observe(instance, key);
    if (observation.kind === "unstable") {
      return {
        ok: false,
        fingerprints: [],
        issues: [{ code: "UNSTABLE_READ", message: observation.reason }],
      };
    }
    const actual = [observation.fingerprint];
    const expectedSet = fingerprintSet(expected.fingerprints);
    const actualSet = fingerprintSet(actual);
    const ok =
      expectedSet.size === expected.fingerprints.length &&
      actualSet.size === actual.length &&
      expectedSet.size === actualSet.size &&
      [...expectedSet].every((item) => actualSet.has(item));
    return {
      ok,
      fingerprints: actual,
      issues: ok ? [] : [{ code: "PLAN_STALE", message: "Codex fingerprints changed" }],
    };
  }

  debugCounters(): CodexDebugCounters {
    return { rolloutBodyReads: this.bodyReads, rolloutProbeReads: this.probeReads };
  }

  resetDebugCounters(): void {
    this.bodyReads = 0;
    this.probeReads = 0;
  }
}

export * from "./catalog.js";
export * from "./normalizer.js";
export * from "./parser.js";
export * from "./probe.js";
export * from "./projects.js";
export * from "./stable-read.js";
export * from "./status.js";
export * from "./thread.js";
