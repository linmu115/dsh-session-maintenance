import type { AppServerTransport } from "./types.js";

export class ScriptedAppServerTransport implements AppServerTransport {
  private readonly platformVersion: string;
  private readonly responses: Readonly<Record<string, unknown>>;
  private readonly notifications: Readonly<Record<string, readonly unknown[]>>;
  private readonly failures = new Map<string, Error>();
  private readonly methods: string[] = [];

  constructor(input: {
    readonly version: string;
    readonly responses: Readonly<Record<string, unknown>>;
    readonly notifications: Readonly<Record<string, readonly unknown[]>>;
  }) {
    this.platformVersion = input.version;
    this.responses = input.responses;
    this.notifications = input.notifications;
  }

  version(): Promise<string> {
    return Promise.resolve(this.platformVersion);
  }

  request<T>(method: string, _params: unknown): Promise<T> {
    this.methods.push(method);
    const failure = this.failures.get(method);
    if (failure !== undefined) return Promise.reject(failure);
    if (!(method in this.responses)) return Promise.reject(new Error(`Unexpected request: ${method}`));
    return Promise.resolve(structuredClone(this.responses[method]) as T);
  }

  notify(_method: string, _params?: unknown): Promise<void> {
    return Promise.resolve();
  }

  waitForNotification<T>(
    method: string,
    predicate: (params: T) => boolean,
    _timeoutMs: number,
  ): Promise<T> {
    const match = (this.notifications[method] ?? []).find((params) => predicate(params as T));
    return match === undefined
      ? Promise.reject(new Error(`Expected notification was not scripted: ${method}`))
      : Promise.resolve(structuredClone(match) as T);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  failRequest(method: string, error: Error): void {
    this.failures.set(method, error);
  }

  requestedMethods(): readonly string[] {
    return [...this.methods];
  }
}
