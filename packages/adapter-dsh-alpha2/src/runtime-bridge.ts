import type {
  DshRuntimeBridgeV1,
  JsonValue,
  LogicalSessionId,
  NativeAppendOperation,
  NativeSessionRegistration,
  ProjectionOperationReceipt,
  RunId,
  RuntimeAttachContext,
  RuntimeDrainResult,
  RuntimeHandle,
  SessionVersionId,
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
  drainSession?(registrationId: string, runId: RunId, nativeSessionId: NativeAppendOperation["nativeSessionId"]): Promise<RuntimeDrainResult>;
  hideSession?(registrationId: string, runId: RunId, nativeSessionId: NativeAppendOperation["nativeSessionId"]): Promise<void>;
  detach(registrationId: string, runId: RunId): Promise<void>;
}

export interface Alpha2MutableProjection {
  readSession(nativeSessionId: NativeAppendOperation["nativeSessionId"]): Promise<JsonValue>;
  replaceSession(nativeSessionId: NativeAppendOperation["nativeSessionId"], payload: JsonValue): Promise<void>;
  writeSession?(nativeSessionId: NativeAppendOperation["nativeSessionId"], payload: JsonValue): Promise<void>;
}

export type Alpha2AppendHandler = (
  operation: NativeAppendOperation,
) => Promise<ProjectionOperationReceipt>;

function record(value: JsonValue, description: string): { readonly [key: string]: JsonValue } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value as { readonly [key: string]: JsonValue };
}

export class Alpha2RuntimeBridge implements DshRuntimeBridgeV1 {
  readonly registrar: Alpha2RuntimeRegistrar;
  private readonly registrations = new Map<RunId, Alpha2RuntimeRegistration>();
  private readonly appendHandlers = new Map<RunId, Alpha2AppendHandler>();
  private readonly drainingRuns = new Set<RunId>();

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
    this.drainingRuns.add(handle.runId);
    return this.registrar.drain(registration.registrationId, handle.runId);
  }

  async drainSession(handle: RuntimeHandle, nativeSessionId: NativeAppendOperation["nativeSessionId"]): Promise<RuntimeDrainResult> {
    const registration = this.registration(handle);
    return this.registrar.drainSession === undefined
      ? this.registrar.drain(registration.registrationId, handle.runId)
      : this.registrar.drainSession(registration.registrationId, handle.runId, nativeSessionId);
  }

  async detach(handle: RuntimeHandle): Promise<void> {
    const registration = this.registration(handle);
    await this.registrar.detach(registration.registrationId, handle.runId);
    this.registrations.delete(handle.runId);
    this.appendHandlers.delete(handle.runId);
    this.drainingRuns.delete(handle.runId);
  }

  async hideSession(handle: RuntimeHandle, nativeSessionId: NativeAppendOperation["nativeSessionId"]): Promise<void> {
    const registration = this.registration(handle);
    if (this.registrar.hideSession === undefined) throw new Error("Alpha2 runtime registrar cannot hide a projected session");
    await this.registrar.hideSession(registration.registrationId, handle.runId, nativeSessionId);
  }

  async bindAppendHandler(handle: RuntimeHandle, handler: Alpha2AppendHandler): Promise<void> {
    this.registration(handle);
    if (this.appendHandlers.has(handle.runId)) {
      throw new Error(`Alpha2 append handler is already bound for ${handle.runId}`);
    }
    this.appendHandlers.set(handle.runId, handler);
  }

  async submitAppend(operation: NativeAppendOperation): Promise<ProjectionOperationReceipt> {
    if (this.drainingRuns.has(operation.runId)) {
      throw new Error(`Alpha2 runtime is draining and rejects new appends for ${operation.runId}`);
    }
    const handler = this.appendHandlers.get(operation.runId);
    if (handler === undefined) throw new Error(`Alpha2 append handler is not bound for ${operation.runId}`);
    return handler(operation);
  }

  async applyAppend(
    handle: RuntimeHandle,
    operation: NativeAppendOperation,
    projection: Alpha2MutableProjection,
  ): Promise<void> {
    const { session, appendedEvents } = await this.validateAppend(handle, operation, projection);
    await projection.replaceSession(operation.nativeSessionId, {
      ...session,
      events: [...session.events as readonly JsonValue[], ...appendedEvents],
    });
  }

  async registerSession(
    handle: RuntimeHandle,
    registration: NativeSessionRegistration,
    projection: Alpha2MutableProjection,
  ): Promise<void> {
    this.registration(handle);
    if (projection.writeSession === undefined) throw new Error("Alpha2 projection cannot register a new native session");
    const header = record(registration.header, "Alpha2 new SessionHeader");
    if (header.id !== registration.nativeSessionId) throw new Error("Alpha2 new SessionHeader ID does not match nativeSessionId");
    await projection.writeSession(registration.nativeSessionId, {
      schemaVersion: 1,
      logicalSessionId: registration.logicalSessionId,
      baseVersionId: null,
      workspaceId: registration.workspaceId,
      title: registration.title,
      tags: [],
      header,
      events: [],
    });
  }

  async validateAppend(
    handle: RuntimeHandle,
    operation: NativeAppendOperation,
    projection: Pick<Alpha2MutableProjection, "readSession">,
  ): Promise<{
    readonly session: { readonly [key: string]: JsonValue };
    readonly appendedEvents: readonly JsonValue[];
  }> {
    this.registration(handle);
    if (handle.runId !== operation.runId) throw new Error("Alpha2 append belongs to another runtime handle");
    const session = record(await projection.readSession(operation.nativeSessionId), "Alpha2 projection session");
    const payload = record(operation.payload, "Alpha2 append payload");
    if (session.logicalSessionId !== payload.logicalSessionId) {
      throw new Error("Alpha2 append logical session does not match the projection");
    }
    if (!Array.isArray(session.events) || !Array.isArray(payload.events)) {
      throw new TypeError("Alpha2 session and append require event arrays");
    }
    const currentRevision = session.events.length;
    if (operation.nativeRevision !== currentRevision + payload.events.length) {
      throw new Error(`Alpha2 native revision mismatch: ${currentRevision} -> ${operation.nativeRevision}`);
    }
    payload.events.forEach((eventValue, index) => {
      const event = record(eventValue, "Alpha2 append event");
      if (event.seq !== currentRevision + index) {
        throw new Error(`Alpha2 append event sequence is not contiguous: ${String(event.seq)}`);
      }
    });
    return { session, appendedEvents: payload.events };
  }

  async switchLogicalSession(
    handle: RuntimeHandle,
    nativeSessionId: NativeAppendOperation["nativeSessionId"],
    logicalSessionId: LogicalSessionId,
    baseVersionId: SessionVersionId | null,
    projection: Alpha2MutableProjection,
  ): Promise<void> {
    this.registration(handle);
    const session = record(await projection.readSession(nativeSessionId), "Alpha2 projection session");
    await projection.replaceSession(nativeSessionId, {
      ...session,
      logicalSessionId,
      baseVersionId,
    });
  }

  private registration(handle: RuntimeHandle): Alpha2RuntimeRegistration {
    if (handle.adapterId !== manifest.id) throw new Error("Runtime handle belongs to another Adapter");
    const registration = this.registrations.get(handle.runId);
    if (registration === undefined) throw new Error(`Alpha2 runtime is not attached for ${handle.runId}`);
    return registration;
  }
}
