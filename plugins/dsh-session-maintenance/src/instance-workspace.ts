import type { Context } from '@deepseek-ai/cordis';
import { instanceSessionAvailabilitySchema, instanceWorkspaceEffectiveScopeSchema } from '@linmu/dsh-session-contracts';
import type { EngineConnectionProvider } from './engine-proxy.js';

export interface MaintenanceInstanceIdentity { readonly instanceId: string; readonly profileId: string; }

/** Host-only access, bound to the prepared instance; Engine credentials never reach a consumer UI. */
export class MaintenanceInstanceWorkspace {
  constructor(readonly identity: MaintenanceInstanceIdentity, private readonly connection: EngineConnectionProvider,
    private readonly fetchImpl: typeof fetch = fetch) {}
  private async read(path: string): Promise<unknown> {
    const connection = await this.connection.current();
    const response = await this.fetchImpl(`${connection.origin}/v1/instances/${encodeURIComponent(this.identity.instanceId)}/${path}?${new URLSearchParams({profileId:this.identity.profileId})}`, {
      headers: {authorization:`Bearer ${connection.token}`}, signal:AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Maintenance instance scope unavailable (${response.status})`);
    return response.json();
  }
  async effectiveScope() {
    const result = await this.read('workspace-scope') as {scope?:unknown};
    const scope = instanceWorkspaceEffectiveScopeSchema.parse(result.scope);
    if (scope.instanceId !== this.identity.instanceId || scope.profileId !== this.identity.profileId) throw new Error('Maintenance scope identity mismatch');
    return scope;
  }
  async sessionAvailability(logicalSessionId: string) {
    instanceSessionAvailabilitySchema.shape.logicalSessionId.parse(logicalSessionId);
    const result = await this.read(`sessions/${encodeURIComponent(logicalSessionId)}/availability`) as {availability?:unknown};
    const availability = instanceSessionAvailabilitySchema.parse(result.availability);
    if (availability.instanceId !== this.identity.instanceId || availability.profileId !== this.identity.profileId || availability.logicalSessionId !== logicalSessionId)
      throw new Error('Maintenance session availability identity mismatch');
    return availability;
  }
}

export function registerMaintenanceInstanceWorkspace(ctx: Context, identity: MaintenanceInstanceIdentity, connection: EngineConnectionProvider): void {
  const stableIdentity = Object.freeze({...identity});
  ctx.provide('maintenanceInstanceIdentity', stableIdentity);
  ctx.provide('maintenanceInstanceWorkspace', new MaintenanceInstanceWorkspace(stableIdentity, connection));
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    maintenanceInstanceIdentity: MaintenanceInstanceIdentity;
    maintenanceInstanceWorkspace: MaintenanceInstanceWorkspace;
  }
}
