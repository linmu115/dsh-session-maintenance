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

import { normalizeDshObservation } from "./normalizer.js";
import { probeDshInstance } from "./probe.js";
import {
  listDshSessions,
  observeDshSession,
  type DshReadHooks,
} from "./reader.js";

export interface DshReadAdapterOptions {
  readonly fixtureGuard?: (root: string) => void;
  readonly afterRead?: (path: string) => void | Promise<void>;
}

export interface DshDebugCounters {
  readonly headerFrameReads: number;
  readonly fullArtifactReads: number;
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

export class DshReadAdapter implements SessionReadAdapter {
  readonly platform = "dsh" as const;
  private readonly options: DshReadAdapterOptions;
  private headerReads = 0;
  private fullReads = 0;

  constructor(options: DshReadAdapterOptions = {}) {
    if (process.env.VITEST !== undefined && options.fixtureGuard === undefined) {
      throw new Error("DshReadAdapter requires a fixture guard under Vitest");
    }
    this.options = options;
  }

  private hooks(): DshReadHooks {
    return {
      ...(this.options.fixtureGuard === undefined ? {} : { fixtureGuard: this.options.fixtureGuard }),
      ...(this.options.afterRead === undefined ? {} : { afterRead: this.options.afterRead }),
      onHeaderRead: () => {
        this.headerReads += 1;
      },
      onFullRead: () => {
        this.fullReads += 1;
      },
    };
  }

  probe(instance: RegisteredInstance): Promise<AdapterProbe> {
    return probeDshInstance(instance, this.hooks());
  }

  list(instance: RegisteredInstance, cursor?: ScanCursor): AsyncIterable<PlatformSessionSummary> {
    return listDshSessions(instance, cursor, this.hooks());
  }

  observe(
    instance: RegisteredInstance,
    key: PlatformSessionKey,
    hint?: ObservationHint,
  ): Promise<StableObservation | UnstableRead> {
    return observeDshSession(instance, key, hint, this.hooks());
  }

  normalize(observation: StableObservation): Promise<NormalizedSession> {
    return Promise.resolve(normalizeDshObservation(observation));
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
      issues: ok ? [] : [{ code: "PLAN_STALE", message: "DSH fingerprints changed" }],
    };
  }

  debugCounters(): DshDebugCounters {
    return { headerFrameReads: this.headerReads, fullArtifactReads: this.fullReads };
  }

  resetDebugCounters(): void {
    this.headerReads = 0;
    this.fullReads = 0;
  }
}

export * from "./normalizer.js";
export * from "./probe.js";
export * from "./reader.js";
export * from "./zstd-codec.js";
