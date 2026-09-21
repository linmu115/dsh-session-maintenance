import type { ProxyRequest, ProxyResult } from "../engine-proxy.js";

export interface ObservableSnapshot<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export interface SessionListSnapshot {
  readonly current?: string;
  readonly byId?: Readonly<Record<string, { readonly title?: string; readonly archived?: boolean } | undefined>>;
}

export interface SettingsSectionRegistration {
  readonly name: "settings.section";
  readonly id: string;
  readonly order: number;
  readonly label: string | (() => string);
  readonly inject?: () => Readonly<Record<string, unknown>>;
}

export interface ConversationNodeRegistration {
  readonly name: "conversation.chat.node";
  readonly key: string;
  readonly inject?: (sessionId: string) => Readonly<Record<string, unknown>>;
}

export interface ClientSlots {
  inject(name: string, callback: () => () => void): () => void;
  register(registration: SettingsSectionRegistration | ConversationNodeRegistration, component: unknown): () => void;
}

export interface ClientConversationEvents {
  register(definition: unknown): () => void;
}

export interface ClientContext {
  readonly sessions: { readonly list: ObservableSnapshot<SessionListSnapshot> };
  readonly slots: ClientSlots;
  readonly uiConversation: { readonly events: ClientConversationEvents };
  inject(names: readonly string[], callback: (ctx: ClientContext) => void | Promise<void> | (() => void)): { dispose(): void | Promise<void> };
  effect(callback: () => void | (() => void), label?: string): void;
  get(name: string): unknown;
}

export interface MaintenanceActions {
  invoke(input: ProxyRequest, options?: { readonly signal?: AbortSignal }): Promise<ProxyResult>;
}

/** The reason the host refused a maintenance call; it is what the workspace bridge reports. */
export type ClientFailureCode = "engine-unreachable" | "engine-error" | "invalid-input";

/** A refusal the caller can act on: the code says whether retrying later is worth anything. */
export class ClientActionError extends Error {
  constructor(readonly code: ClientFailureCode, message: string) { super(message); this.name = "ClientActionError"; }
}

export function createMaintenanceActions(fetchImpl: typeof fetch = fetch): MaintenanceActions {
  return {
    async invoke(input, options) {
      options?.signal?.throwIfAborted();
      let response: Response;
      try {
        response = await fetchImpl("/dsh-session-maintenance/api", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        // The plugin's own host endpoint is gone: that is the same "not there yet" answer as a
        // stopped Engine, and it is the one outcome that must stay retryable.
        throw new ClientActionError("engine-unreachable", error instanceof Error ? error.message : "无法访问实例维护接口");
      }
      const value = await response.json() as ProxyResult | { readonly ok: false; readonly code?: ClientFailureCode; readonly error?: string };
      options?.signal?.throwIfAborted();
      if (!response.ok || value.ok !== true) {
        const failure = value as { readonly code?: ClientFailureCode; readonly error?: string };
        throw new ClientActionError(failure.code ?? "engine-error", "error" in value && value.error !== undefined ? value.error : "维护操作失败");
      }
      return value;
    },
  };
}
