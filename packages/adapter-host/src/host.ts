import type {
  AdapterProbeResult,
  DshEnvironmentDescriptor,
  JsonValue,
} from "@linmu/dsh-session-contracts";

import type { AdapterRegistration } from "./registry.js";
import type { AdapterWorkerFactory } from "./rpc.js";

export interface AdapterHostOptions {
  readonly timeoutMs?: number;
}

export class AdapterHost {
  readonly factory: AdapterWorkerFactory;
  private readonly timeoutMs: number;

  constructor(factory: AdapterWorkerFactory, options: AdapterHostOptions = {}) {
    this.factory = factory;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async probe(
    registration: AdapterRegistration,
    environment: DshEnvironmentDescriptor,
  ): Promise<AdapterProbeResult> {
    let worker: Awaited<ReturnType<AdapterWorkerFactory["launch"]>> | undefined;
    try {
      worker = await this.factory.launch({
        entryPoint: registration.source.entryPoint,
        manifest: registration.manifest,
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        worker.request("probe", environment as unknown as JsonValue),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Adapter probe timed out")), this.timeoutMs);
          timeout.unref?.();
        }),
      ]).finally(() => {
        if (timeout !== undefined) clearTimeout(timeout);
      });
      const probe = result as unknown as AdapterProbeResult;
      if (
        typeof probe !== "object" ||
        probe === null ||
        probe.manifest?.id !== registration.manifest.id ||
        !["verified", "compatible", "experimental", "failed"].includes(probe.status)
      ) {
        throw new Error("Adapter probe returned an invalid DTO");
      }
      return probe;
    } catch {
      return {
        status: "failed",
        manifest: registration.manifest,
        detectedDshVersion: environment.dshVersion,
        capabilities: [],
        issues: [{
          code: "ADAPTER_PROCESS_FAILED",
          message: "Adapter process exited, timed out, or returned an invalid probe DTO",
        }],
      };
    } finally {
      await worker?.close().catch(() => undefined);
    }
  }
}
