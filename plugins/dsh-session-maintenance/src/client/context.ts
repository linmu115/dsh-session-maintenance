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

export function createMaintenanceActions(fetchImpl: typeof fetch = fetch): MaintenanceActions {
  return {
    async invoke(input, options) {
      options?.signal?.throwIfAborted();
      const response = await fetchImpl("/dsh-session-maintenance/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      const value = await response.json() as ProxyResult | { readonly ok: false; readonly error?: string };
      options?.signal?.throwIfAborted();
      if (!response.ok || value.ok !== true) throw new Error("error" in value ? value.error ?? "维护操作失败" : "维护操作失败");
      return value;
    },
  };
}
