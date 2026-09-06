import { resolve } from "node:path";

import type { DshSessionAdapterV1, JsonValue, ProjectionRun } from "@linmu/dsh-session-contracts";
import type { StatusLog } from "@linmu/dsh-session-status-log";

import type { CanonicalProjectionSource, IncrementalCanonicalProjectionSource } from "./materialize.js";
import { PersistentProjectionCache } from "./persistent-cache.js";

/** Cache attachment only: the lifecycle remains the owner of run/lease state. */
export interface RunCacheContext {
  readonly manager: PersistentProjectionCache;
  readonly cacheRoot: string;
  readonly configuration: JsonValue;
}

export function createRunCacheManager(input: {
  readonly runtimeRoot: string;
  readonly source: CanonicalProjectionSource;
  readonly adapter: DshSessionAdapterV1;
  readonly statusLog: StatusLog;
  readonly clock: () => string;
}): PersistentProjectionCache | undefined {
  const source = input.source as Partial<IncrementalCanonicalProjectionSource>;
  if (typeof source.currentRevision !== "function" || typeof source.listChanges !== "function" ||
      typeof source.loadSessions !== "function" || input.adapter.composeProjectionManifest === undefined) return undefined;
  return new PersistentProjectionCache({ ...input, source: source as IncrementalCanonicalProjectionSource });
}

export async function refreshRunCache(context: RunCacheContext | null, run: ProjectionRun, statusLog: StatusLog): Promise<void> {
  if (context === null) return;
  const span = await statusLog.start({
    runId: run.id, leaseId: run.leaseId, profileId: run.profileId, adapterId: run.adapterId,
    dshVersion: run.dshVersion, stage: "projection.cache-retained",
    logicalSessionId: null, nativeSessionId: null, operationId: null,
    diagnosticDetailRef: "diag:projection-cache-refresh-started",
  });
  try {
    const refreshed = await context.manager.apply({ run, configuration: context.configuration });
    if (resolve(refreshed.cacheRoot) !== resolve(context.cacheRoot)) {
      throw new TypeError("Projection cache identity changed while the run was active");
    }
    await statusLog.succeed(span, {
      diagnosticDetailRef: `diag:projection-cache-retained:${refreshed.receipt.throughRevision}:${refreshed.receipt.rewrittenSessions}:${refreshed.receipt.removedSessions}`,
    });
  } catch (error) {
    await statusLog.fail(span, {
      errorCode: "PROJECTION_CACHE_REFRESH_FAILED",
      diagnosticDetailRef: "diag:projection-cache-refresh-failed",
    });
    throw error;
  }
}
