import type { CanonicalSessionEngine } from "@linmu/dsh-canonical-session-engine";
import type { LogicalSessionId, RegisteredInstance, SessionReadAdapter } from "@linmu/dsh-session-contracts";
import { logicalSessionIdFor } from "@linmu/dsh-session-domain";
import { CodexReadAdapter } from "@linmu/dsh-adapter-codex-read";
import { assertCodexImportScope, codexScopeSnapshot, codexScopedProject, type CodexProjectScopeProvider } from "./codex-canonical-import.js";

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
  private readonly projectScope: CodexProjectScopeProvider | undefined;
  private readonly fixtureGuard: ((root: string) => void) | undefined;

  constructor(input: {
    readonly instances: readonly RegisteredInstance[];
    readonly adapters: readonly SessionReadAdapter[];
    readonly canonicalEngine: CanonicalSessionEngine;
    readonly clock?: () => string;
    readonly writes?: import("@linmu/dsh-session-contracts").MaintenanceWriteScope;
    readonly projectScope?: CodexProjectScopeProvider;
    readonly fixtureGuard?: (root: string) => void;
  }) {
    this.projectScope = input.projectScope;
    this.fixtureGuard = input.fixtureGuard;
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
      signal?.throwIfAborted();
      const scope = await this.projectScope?.(instance, signal);
      const expectedScope = codexScopeSnapshot(scope);
      const threadIds = scope === undefined ? undefined : new Set(Object.keys(scope.directory.assignments)
        .filter((id) => codexScopedProject(scope, id) !== undefined));
      if (threadIds?.size === 0) continue;
      const scopedAdapter = threadIds === undefined ? adapter : new CodexReadAdapter({
        threadIds, ...(this.fixtureGuard === undefined ? {} : { fixtureGuard: this.fixtureGuard }),
      });
      for await (const summary of scopedAdapter.list(instance)) {
        signal?.throwIfAborted();
        if (scope !== undefined && codexScopedProject(scope, summary.key.sessionId) === undefined) continue;
        counts.scanned += 1;
        const selected = scope === undefined ? undefined : codexScopedProject(scope, summary.key.sessionId);
        const commit = async () => {
          const current = await assertCodexImportScope({
            instance,
            ...(this.projectScope === undefined ? {} : { projectScope: this.projectScope }),
            ...(expectedScope === undefined ? {} : { expectedScope }),
            sourceSessionId: summary.key.sessionId,
            ...(signal === undefined ? {} : { signal }),
          });
          const fresh = current === undefined ? undefined : codexScopedProject(current, summary.key.sessionId);
          if (selected?.project.projectId !== fresh?.project.projectId || selected?.basis !== fresh?.basis) throw new Error("IMPORT_PROJECT_MEMBERSHIP_CHANGED");
          return this.canonicalEngine.retitleCodexMirror({
            logicalSessionId: logicalSessionIdFor(summary.key) as LogicalSessionId,
            title: summary.title,
            appliedAt: this.clock(),
          });
        };
        const receipt = await (this.writes === undefined ? commit() : this.writes.run("codex-title-commit", commit, signal));
        if (receipt === undefined) counts.missing += 1;
        else if (receipt.outcome === "advanced") counts.advanced += 1;
        else counts.unchanged += 1;
      }
    }
    return counts;
  }
}
