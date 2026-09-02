import type { RuntimeBrokerPluginClient } from "./projection-runtime.js";

type AsyncMethod = (sessionId: string, ...args: never[]) => Promise<unknown>;

export interface LazySessionHeader {
  readonly id: string;
  readonly createdAt?: number;
  readonly [key: string]: unknown;
}

export interface LazyReadableSessionPersistence {
  borrowSession: AsyncMethod;
  inspect: AsyncMethod;
  readFrom: AsyncMethod;
  list(signal?: AbortSignal): Promise<LazySessionHeader[]>;
}

export type LazyHydrationStage = "lazy.catalog.ready" | "lazy.borrow.request" | "lazy.materialize.commit" | "lazy.materialize.failed";

/**
 * Alpha2 has no before-open middleware, but all cold history paths cross these
 * public SessionPersistence read methods. Decorate only that boundary and
 * restore every descriptor when the plugin fiber is disposed.
 */
export function installLazyProjectionPersistence(
  persistence: LazyReadableSessionPersistence,
  runtime: RuntimeBrokerPluginClient,
  status: (stage: LazyHydrationStage, sessionId?: string, error?: unknown) => void = () => undefined,
): () => void {
  const names = ["borrowSession", "inspect", "readFrom"] as const;
  const descriptors = new Map<typeof names[number], PropertyDescriptor | undefined>();
  const listDescriptor = Object.getOwnPropertyDescriptor(persistence, "list");
  const originalList = persistence.list;
  if (typeof originalList !== "function") throw new TypeError("Alpha2 SessionPersistence lacks list()");
  const tails = new Map<string, Promise<void>>();
  status("lazy.catalog.ready");

  const hydrate = (sessionId: string): Promise<void> => {
    const existing = tails.get(sessionId);
    if (existing !== undefined) return existing;
    status("lazy.borrow.request", sessionId);
    const tail = runtime.hydrate(sessionId).then(() => {
      status("lazy.materialize.commit", sessionId);
    }, (error) => {
      status("lazy.materialize.failed", sessionId, error);
      throw error;
    }).finally(() => tails.delete(sessionId));
    tails.set(sessionId, tail);
    return tail;
  };

  for (const name of names) {
    const original = persistence[name];
    if (typeof original !== "function") throw new TypeError(`Alpha2 SessionPersistence lacks ${name}()`);
    descriptors.set(name, Object.getOwnPropertyDescriptor(persistence, name));
    const wrapped: AsyncMethod = async function(this: LazyReadableSessionPersistence, sessionId, ...args) {
      if (runtime.coldSessionIds().includes(sessionId)) await hydrate(sessionId);
      return original.call(this, sessionId, ...args);
    };
    Object.defineProperty(persistence, name, {
      configurable: true,
      enumerable: descriptors.get(name)?.enumerable ?? false,
      writable: true,
      value: wrapped,
    });
  }

  Object.defineProperty(persistence, "list", {
    configurable: true,
    enumerable: listDescriptor?.enumerable ?? false,
    writable: true,
    value: async function(this: LazyReadableSessionPersistence, signal?: AbortSignal): Promise<LazySessionHeader[]> {
      const native = await originalList.call(this, signal);
      const merged = new Map<string, LazySessionHeader>();
      for (const value of runtime.sessionHeaders()) {
        if (value === null || typeof value !== "object" || Array.isArray(value)
          || typeof (value as { readonly id?: unknown }).id !== "string") {
          throw new TypeError("Maintenance projection catalog contains an invalid SessionHeader");
        }
        const header = structuredClone(value) as LazySessionHeader;
        merged.set(header.id, header);
      }
      // A live-created or already materialized native header is authoritative
      // for that exact ID; the catalog only supplies missing cold rows.
      for (const header of native) merged.set(header.id, header);
      return [...merged.values()];
    },
  });

  return () => {
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor === undefined) delete persistence[name];
      else Object.defineProperty(persistence, name, descriptor);
    }
    if (listDescriptor === undefined) delete (persistence as Partial<LazyReadableSessionPersistence>).list;
    else Object.defineProperty(persistence, "list", listDescriptor);
    tails.clear();
  };
}
