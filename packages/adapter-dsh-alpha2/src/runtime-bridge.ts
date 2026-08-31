import type {
  DshRuntimeBridgeV1,
  RunId,
  RuntimeAttachContext,
  RuntimeDrainResult,
  RuntimeHandle,
} from "@linmu/dsh-session-adapter-sdk";

import { manifest } from "./manifest.js";

export interface Alpha2RuntimeRegistration {
  readonly registrationId: string;
  readonly attachedAt: string;
}

export interface Alpha2RuntimeRegistrar {
  attach(input: {
    readonly runId: RunId;
    readonly maintenanceEndpoint: string;
  }): Promise<Alpha2RuntimeRegistration>;
  drain(registrationId: string, runId: RunId): Promise<RuntimeDrainResult>;
  detach(registrationId: string, runId: RunId): Promise<void>;
}

export class Alpha2RuntimeBridge implements DshRuntimeBridgeV1 {
  readonly registrar: Alpha2RuntimeRegistrar;
  private readonly registrations = new Map<RunId, Alpha2RuntimeRegistration>();

  constructor(registrar: Alpha2RuntimeRegistrar) {
    this.registrar = registrar;
  }

  async attach(context: RuntimeAttachContext): Promise<RuntimeHandle> {
    if (this.registrations.has(context.run.id)) {
      throw new Error(`Alpha2 runtime is already attached for ${context.run.id}`);
    }
    const registration = await this.registrar.attach({
      runId: context.run.id,
      maintenanceEndpoint: context.maintenanceEndpoint,
    });
    this.registrations.set(context.run.id, registration);
    return {
      runId: context.run.id,
      adapterId: manifest.id,
      attachedAt: registration.attachedAt,
    };
  }

  async drain(handle: RuntimeHandle): Promise<RuntimeDrainResult> {
    const registration = this.registration(handle);
    return this.registrar.drain(registration.registrationId, handle.runId);
  }

  async detach(handle: RuntimeHandle): Promise<void> {
    const registration = this.registration(handle);
    await this.registrar.detach(registration.registrationId, handle.runId);
    this.registrations.delete(handle.runId);
  }

  private registration(handle: RuntimeHandle): Alpha2RuntimeRegistration {
    if (handle.adapterId !== manifest.id) throw new Error("Runtime handle belongs to another Adapter");
    const registration = this.registrations.get(handle.runId);
    if (registration === undefined) throw new Error(`Alpha2 runtime is not attached for ${handle.runId}`);
    return registration;
  }
}
