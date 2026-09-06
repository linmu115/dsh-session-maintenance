import type { CanonicalSessionEngine } from "@linmu/dsh-canonical-session-engine";
import type { LogicalSessionId, RegisteredInstance, SessionReadAdapter } from "@linmu/dsh-session-contracts";
import { logicalSessionIdFor } from "@linmu/dsh-session-domain";

export interface CodexCatalogTitleSyncResult {
  readonly scanned: number;
  readonly advanced: number;
  readonly unchanged: number;
  readonly missing: number;
}

/** Cheap catalog-only sync: never reads a Codex rollout body. */
export class CodexCatalogTitleSyncService {
  private readonly instances: readonly RegisteredInstance[];
  private readonly adapters: readonly SessionReadAdapter[];
  private readonly canonicalEngine: CanonicalSessionEngine;
  private readonly clock: () => string;
  private readonly writes: import("@linmu/dsh-session-contracts").MaintenanceWriteScope | undefined;

  constructor(input: {
    readonly instances: readonly RegisteredInstance[];
    readonly adapters: readonly SessionReadAdapter[];
    readonly canonicalEngine: CanonicalSessionEngine;
    readonly clock?: () => string;
    readonly writes?: import("@linmu/dsh-session-contracts").MaintenanceWriteScope;
  }) {
    this.writes = input.writes;
    this.instances = input.instances;
    this.adapters = input.adapters;
    this.canonicalEngine = input.canonicalEngine;
    this.clock = input.clock ?? (() => new Date().toISOString());
  }

  async sync(signal?: AbortSignal): Promise<CodexCatalogTitleSyncResult> {
    const counts = { scanned: 0, advanced: 0, unchanged: 0, missing: 0 };
    const adapter = this.adapters.find((candidate) => candidate.platform === "codex");
    const instances = this.instances.filter((instance) => instance.platform === "codex");
    if (adapter === undefined || instances.length === 0) return counts;
    for (const instance of instances) {
      for await (const summary of adapter.list(instance)) {
        signal?.throwIfAborted();
        counts.scanned += 1;
        const commit = () => this.canonicalEngine.retitleCodexMirror({
          logicalSessionId: logicalSessionIdFor(summary.key) as LogicalSessionId,
          title: summary.title,
          appliedAt: this.clock(),
        });
        const receipt = await (this.writes === undefined ? commit() : this.writes.run("codex-title-commit", commit, signal));
        if (receipt === undefined) counts.missing += 1;
        else if (receipt.outcome === "advanced") counts.advanced += 1;
        else counts.unchanged += 1;
      }
    }
    return counts;
  }
}
