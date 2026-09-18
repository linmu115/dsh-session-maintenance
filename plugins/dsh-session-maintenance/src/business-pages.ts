import type { Context } from "@deepseek-ai/cordis";
import { businessPageOwnerSchema, businessPageSnapshotSchema, businessPageActionRequestSchema, businessPageActionResultSchema,
  type BusinessPageSnapshot, type BusinessPageActionRequest, type BusinessPageActionResult, type BusinessPageOwner } from "@linmu/dsh-session-contracts";
import type { EngineConnectionProvider } from "./engine-proxy.js";
import type { BusinessPageProvider, MaintenanceBusinessPagesService } from "./business-pages-api.js";
export type { BusinessPageProvider } from "./business-pages-api.js";
export class MaintenanceBusinessPages {
  readonly identity: Readonly<{ instanceId: string; profileId: string }>;
  private registrations = new Map<string, () => void>();
  private releases = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private readonly connection: EngineConnectionProvider, scope: { instanceId: string; profileId: string },
    private readonly fetchImpl: typeof fetch = fetch) { this.identity = Object.freeze({ instanceId: scope.instanceId, profileId: scope.profileId }); }
  private async request(path: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const connection = await this.connection.current();
    const response = await this.fetchImpl(`${connection.origin}/v1/business-pages/${path}`, { method: "POST", headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
      body: JSON.stringify(input), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Maintenance business page request failed (${response.status})`);
    return response.json();
  }
  register(provider: BusinessPageProvider): () => void {
    if (this.closed) throw new Error("Maintenance business pages service is closed");
    const owner = businessPageOwnerSchema.parse({ ...this.identity, namespace: provider.namespace, providerId: provider.providerId, bootId: crypto.randomUUID() });
    const key = JSON.stringify([owner.namespace, owner.providerId]);
    if (this.registrations.has(key)) throw new Error("Business page provider is already registered");
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const heartbeat = setInterval(() => { void this.request("heartbeat", owner, abort.signal).catch(() => undefined); }, 5000);
    heartbeat.unref?.();
    const completed = new Map<string, Promise<{ status: "completed" | "failed"; message: string }>>();
    const cycle = async () => {
      try {
        const snapshot = businessPageSnapshotSchema.parse(await provider.snapshot());
        abort.signal.throwIfAborted();
        await this.request("register", { owner, snapshot }, abort.signal);
        const result = await this.request("poll", owner, abort.signal) as { actions: unknown[] };
        if (!Array.isArray(result.actions) || result.actions.length > 20) throw new Error("Invalid business page action batch");
        for (const raw of result.actions) {
          abort.signal.throwIfAborted();
          const action = businessPageActionRequestSchema.parse(raw);
          if (JSON.stringify(action.owner) !== JSON.stringify(owner)) throw new Error("Business page action belongs to another provider");
          let execution = completed.get(action.operationId);
          if (!execution) {
            execution = (async () => {
              try {
                const current = businessPageSnapshotSchema.parse(await provider.snapshot());
                if (!current.sections.some(section => section.kind === "actions" && section.actions.some(item => item.id === action.actionId && item.expectedRevision === action.expectedRevision)))
                  throw new Error("业务动作或修订已改变，请刷新后重试。");
                abort.signal.throwIfAborted();
                const result = businessPageActionResultSchema.parse(await provider.handleAction(action, abort.signal));
                return { status: "completed" as const, message: result.message };
              } catch (error) { return { status: "failed" as const, message: (error instanceof Error ? error.message : "业务操作失败").slice(0, 4000) }; }
            })();
            completed.set(action.operationId, execution);
          }
          const receipt = await execution;
          abort.signal.throwIfAborted();
          await this.request("ack", { owner, operationId: action.operationId, ...receipt }, abort.signal);
        }
      } catch { /* Optional capability: retain offline page and receipts, retry only while registered. */ }
      finally { if (!abort.signal.aborted) { timer = setTimeout(() => void cycle(), 5000); timer.unref?.(); } }
    };
    const dispose = () => {
      if (abort.signal.aborted) return;
      abort.abort(); clearInterval(heartbeat); if (timer) clearTimeout(timer); this.registrations.delete(key);
      const release = this.request("unregister", owner).catch(() => undefined);
      this.releases.add(release); void release.finally(() => this.releases.delete(release));
    };
    this.registrations.set(key, dispose); void cycle(); return dispose;
  }
  async dispose(): Promise<void> { this.closed = true; for (const dispose of [...this.registrations.values()]) dispose(); await Promise.allSettled([...this.releases]); }
}
export async function registerMaintenanceBusinessPages(ctx: Context, connection: EngineConnectionProvider, scope: { instanceId: string; profileId: string }): Promise<void> {
  const { Service } = await import("@deepseek-ai/cordis");
  const bridge = new MaintenanceBusinessPages(connection, scope);
  class BusinessPagesService extends Service {
    constructor() { super(ctx, "maintenanceBusinessPages"); }
    readonly identity = bridge.identity;
    register(provider: BusinessPageProvider): () => void { return bridge.register(provider); }
  }
  new BusinessPagesService(); ctx.effect(() => () => bridge.dispose(), "maintenance.business-pages");
}
declare module "@deepseek-ai/cordis" { interface Context { maintenanceBusinessPages: MaintenanceBusinessPagesService } }
