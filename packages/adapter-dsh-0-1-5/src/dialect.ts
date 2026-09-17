import { AsyncLocalStorage } from "node:async_hooks";
import type { AdapterManifestV1, DshEnvironmentDescriptor, AdapterProbeResult } from "@linmu/dsh-session-adapter-sdk";
import type { SessionFormatCatalog } from "@deepseek-ai/dsh-session-format";
import { manifest } from "./manifest.js";

/** A separately registered format owner. Calls retain their own dialect across awaits. */
export interface V3AdapterDialect {
  readonly manifest: AdapterManifestV1;
  readonly formatId: string;
  readonly catalog: SessionFormatCatalog;
  readonly knownEventTypes: ReadonlySet<string>;
  readonly probe: (environment: DshEnvironmentDescriptor) => AdapterProbeResult;
}
const scope = new AsyncLocalStorage<V3AdapterDialect>();
export const currentDialect = (): V3AdapterDialect | undefined => scope.getStore();
export const currentManifest = (): AdapterManifestV1 => currentDialect()?.manifest ?? manifest;
export const currentFormatId = (): string => currentDialect()?.formatId ?? "dsh-0.1.5-v3-jsonl-zstd-v1";

/** Wrap the public methods of one adapter service; never change the default owner. */
export function scopeV3Service<T extends object>(value: T, dialect: V3AdapterDialect): T {
  return new Proxy(value, {
    get(target, key) {
      const member: unknown = scope.run(dialect, () => Reflect.get(target, key, target));
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => scope.run(dialect, () => Reflect.apply(member, target, args));
    },
  });
}
