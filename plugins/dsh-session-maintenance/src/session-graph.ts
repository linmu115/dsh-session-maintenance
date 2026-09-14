import type { Context } from "@deepseek-ai/cordis";
import type {
  GraphResolve, GraphSessionIdentity, GraphPreviewPage, GraphPreviewSelection, GraphRelationPage, SessionContextDirectory,
} from "@linmu/dsh-session-contracts";
import type { EngineConnectionProvider } from "./engine-proxy.js";

/** Host-only current-run access. Plugins never receive an Engine token or pick an instance. */
export class MaintenanceGraph {
  readonly protocolVersion = 1;
  constructor(private readonly connection: EngineConnectionProvider, private readonly runId: string,
    private readonly flush: (nativeSessionId: string) => Promise<unknown>) {}
  private async request<T>(operation: string, input: object): Promise<T> {
    const connection = await this.connection.current();
    const response = await fetch(`${connection.origin}/v1/session-graph/${operation}`, {
      method: "POST", headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...input, runId: this.runId }), signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok) {
      const failure = (result as { error?: { message?: string; code?: string } }).error;
      throw Object.assign(new Error(failure?.message ?? "Maintenance 画布能力暂不可用"),
        { code: failure?.code ?? "GRAPH_UNAVAILABLE", status: response.status });
    }
    return result as T;
  }
  directory(workspaceId?: string, after?: string) {
    return this.request<SessionContextDirectory>("directory", { workspaceId, after });
  }
  resolve(target: GraphResolve) { return this.request<GraphSessionIdentity>("resolve", { target }); }
  async created(nativeSessionId: string) {
    await this.flush(nativeSessionId);
    return this.resolve({ nativeSessionId });
  }
  preview(logicalSessionId: string, cursor?: string, selection?: GraphPreviewSelection) {
    return this.request<GraphPreviewPage>("preview", { logicalSessionId, cursor, selection });
  }
  relations(after?: string) { return this.request<GraphRelationPage>("relations", { after }); }
}
export function registerMaintenanceGraph(ctx: Context, value: MaintenanceGraph) { ctx.provide("maintenanceGraph", value); }
declare module "@deepseek-ai/cordis" { interface Context { maintenanceGraph: MaintenanceGraph } }
