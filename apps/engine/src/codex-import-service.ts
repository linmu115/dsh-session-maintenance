import type { CanonicalSessionEngine } from "@linmu/dsh-canonical-session-engine";
import type { CodexImportRequest, JsonValue, MaintenanceWriteScope, RegisteredInstance, SessionReadAdapter } from "@linmu/dsh-session-contracts";
import { CodexCanonicalImportService, type CodexCanonicalImportOptions } from "./codex-canonical-import.js";
import { CodexCatalogTitleSyncService } from "./codex-catalog-title-sync.js";

/** One registered-instance import entry for HTTP jobs, startup observation and offline tools. */
export class CodexImportService {
  constructor(private readonly input: CodexCanonicalImportOptions & {
    readonly instances: readonly RegisteredInstance[];
    readonly adapters: readonly SessionReadAdapter[];
    readonly canonicalEngine: CanonicalSessionEngine;
    readonly writes: MaintenanceWriteScope;
    readonly clock?: () => string;
  }) {}

  async run(request: CodexImportRequest, signal?: AbortSignal, progress?: (current: number, message: string) => void | Promise<void>): Promise<JsonValue> {
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
        const result = await new CodexCanonicalImportService(this.input).sync({
          instance,
          ...(signal === undefined ? {} : { signal }),
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
