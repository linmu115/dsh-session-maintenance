import type { CanonicalSessionEngine } from "@linmu/dsh-canonical-session-engine";
import type { CodexImportRequest, JsonValue, MaintenanceWriteScope, RegisteredInstance, SessionReadAdapter } from "@linmu/dsh-session-contracts";
import { assertCodexImportScope, codexScopeSnapshot, CodexCanonicalImportService, type CodexCanonicalImportOptions, type CodexImportScopeSnapshot, type CodexImportChangeCache } from "./codex-canonical-import.js";
import { CodexCatalogTitleSyncService } from "./codex-catalog-title-sync.js";

/** One registered-instance import entry for HTTP jobs, startup observation and offline tools. */
export class CodexImportService {
  private readonly changeCache: CodexImportChangeCache = new Map();
  constructor(private readonly input: CodexCanonicalImportOptions & {
    readonly instances: readonly RegisteredInstance[];
    readonly adapters: readonly SessionReadAdapter[];
    readonly canonicalEngine: CanonicalSessionEngine;
    readonly writes: MaintenanceWriteScope;
    readonly clock?: () => string;
  }) {}

  async run(request: CodexImportRequest, signal?: AbortSignal, progress?: (current: number, message: string) => void | Promise<void>): Promise<JsonValue> {
    return this.execute(request, signal, progress);
  }

  /** Background observation is opt-in and shares every foreground scope/commit guard. */
  async runChanged(instanceId: string, signal?: AbortSignal): Promise<JsonValue> {
    const instance = this.input.instances.find((item) => item.id === instanceId && item.platform === "codex");
    if (instance === undefined) throw new Error(`CODEX_INSTANCE_NOT_FOUND: ${instanceId}`);
    signal?.throwIfAborted();
    const scope = await this.input.projectScope?.(instance, signal);
    if (scope === undefined) {
      this.clearChangeCache(instanceId);
      return { instanceId, skippedUnconfigured: true };
    }
    return this.execute({ operationId: `codex-project-observer:${instanceId}`, instanceIds: [instanceId], mode: "content" }, signal, undefined, this.changeCache, codexScopeSnapshot(scope));
  }

  clearChangeCache(instanceId?: string): void {
    if (instanceId === undefined) this.changeCache.clear();
    else for (const key of this.changeCache.keys()) if (key.startsWith(`${instanceId}\0`)) this.changeCache.delete(key);
  }

  private async execute(request: CodexImportRequest, signal?: AbortSignal, progress?: (current: number, message: string) => void | Promise<void>, changeCache?: CodexImportChangeCache, requiredScope?: CodexImportScopeSnapshot): Promise<JsonValue> {
    const options: CodexCanonicalImportOptions = requiredScope === undefined ? this.input : {
      ...this.input,
      projectScope: (instance, scopeSignal) => assertCodexImportScope({
        instance,
        ...(this.input.projectScope === undefined ? {} : { projectScope: this.input.projectScope }),
        expectedScope: requiredScope,
        ...(scopeSignal === undefined ? {} : { signal: scopeSignal }),
      }),
    };
    const instances = request.instanceIds.map((id) => {
      const instance = this.input.instances.find((item) => item.id === id && item.platform === "codex");
      if (instance === undefined) throw new Error(`CODEX_INSTANCE_NOT_FOUND: ${id}`);
      return instance;
    });
    const results: JsonValue[] = [];
    let completed = 0;
    for (const instance of instances) {
      signal?.throwIfAborted();
      if (request.mode === "titles") {
        // Catalog reads remain outside the queue. retitleCodexMirror is the same
        // coordinated canonical commit path and deliberately preserves body cursor.
        const result = await new CodexCatalogTitleSyncService({ ...this.input, instances: [instance] }).sync(signal);
        results.push({ instanceId: instance.id, ...result });
        completed += result.scanned;
        await progress?.(completed, `Observed titles for ${instance.id}`);
      } else {
        const result = await new CodexCanonicalImportService(options).sync({
          instance,
          ...(signal === undefined ? {} : { signal }),
          ...(changeCache === undefined ? {} : { changeCache }),
          onStatus: async (event) => {
            if (event.stage === "canonical.import" && event.state === "succeeded") {
              completed += 1;
              await progress?.(completed, `${event.logicalSessionId}: ${event.outcome}`);
            }
          },
        });
        results.push({ instanceId: instance.id, ...result });
        if (result.retried > 0) throw new Error("IMPORT_SOURCE_UNSTABLE: retry this job after the source settles");
      }
    }
    signal?.throwIfAborted();
    return { operationId: request.operationId, mode: request.mode, instances: results };
  }
}
