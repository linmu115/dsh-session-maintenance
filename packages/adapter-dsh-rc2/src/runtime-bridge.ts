import type { DshRuntimeBridgeV1, NativeSessionId, RunId, RuntimeAttachContext, RuntimeDrainResult, RuntimeHandle } from "@linmu/dsh-session-adapter-sdk";

import { manifest } from "./manifest.js";

export interface Rc2RuntimeRegistrar {
  attachLegacy(input: { readonly runId: RunId; readonly maintenanceEndpoint: string }): Promise<{ readonly registrationId: string; readonly attachedAt: string }>;
  drainLegacy(registrationId: string, runId: RunId, nativeSessionId?: NativeSessionId): Promise<RuntimeDrainResult>;
  hideLegacySession(registrationId: string, runId: RunId, nativeSessionId: NativeSessionId): Promise<void>;
  detachLegacy(registrationId: string, runId: RunId): Promise<void>;
}

export class Rc2RuntimeBridge implements DshRuntimeBridgeV1 {
  readonly registrar: Rc2RuntimeRegistrar;
  private readonly registrations = new Map<RunId, { readonly registrationId: string; readonly attachedAt: string }>();
  constructor(registrar: Rc2RuntimeRegistrar) { this.registrar = registrar; }
  async attach(context: RuntimeAttachContext): Promise<RuntimeHandle> {
    if (this.registrations.has(context.run.id)) throw new Error(`RC2 runtime is already attached for ${context.run.id}`);
    const registration = await this.registrar.attachLegacy({ runId: context.run.id, maintenanceEndpoint: context.maintenanceEndpoint });
    this.registrations.set(context.run.id, registration);
    return { runId: context.run.id, adapterId: manifest.id, attachedAt: registration.attachedAt };
  }
  async drain(handle: RuntimeHandle): Promise<RuntimeDrainResult> { const item = this.registration(handle); return this.registrar.drainLegacy(item.registrationId, handle.runId); }
  async drainSession(handle: RuntimeHandle, nativeSessionId: NativeSessionId): Promise<RuntimeDrainResult> { const item = this.registration(handle); return this.registrar.drainLegacy(item.registrationId, handle.runId, nativeSessionId); }
  async hideSession(handle: RuntimeHandle, nativeSessionId: NativeSessionId): Promise<void> { const item = this.registration(handle); await this.registrar.hideLegacySession(item.registrationId, handle.runId, nativeSessionId); }
  async detach(handle: RuntimeHandle): Promise<void> { const item = this.registration(handle); await this.registrar.detachLegacy(item.registrationId, handle.runId); this.registrations.delete(handle.runId); }
  private registration(handle: RuntimeHandle) {
    if (handle.adapterId !== manifest.id) throw new Error("Runtime handle belongs to another Adapter");
    const item = this.registrations.get(handle.runId);
    if (item === undefined) throw new Error(`RC2 runtime is not attached for ${handle.runId}`);
    return item;
  }
}
