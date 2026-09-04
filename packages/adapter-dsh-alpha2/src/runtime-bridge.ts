import { isDeepStrictEqual } from "node:util";

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
    const { session, appendedEvents, alreadyApplied } = await this.validateAppend(handle, operation, projection);
    if (alreadyApplied) return;
    await projection.replaceSession(operation.nativeSessionId, {
      ...session,
      updatedAt: operation.observedAt,
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
    if (typeof header.createdAt !== "number" || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0) {
      throw new Error("Alpha2 new SessionHeader createdAt is invalid");
    }
    const expected = {
      schemaVersion: 1,
      logicalSessionId: registration.logicalSessionId,
      baseVersionId: null,
      workspaceId: registration.workspaceId,
      projectId: registration.projectId,
      updatedAt: new Date(header.createdAt).toISOString(),
      title: registration.title,
      tags: [],
      header,
      events: [],
    } as const;
    try {
      const existing = await projection.readSession(registration.nativeSessionId);
      if (!isDeepStrictEqual(existing, expected)) {
        throw new Error(`Alpha2 native registration payload already exists with different content: ${registration.nativeSessionId}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await projection.writeSession(registration.nativeSessionId, expected);
    }
  }

  async validateAppend(
    handle: RuntimeHandle,
    operation: NativeAppendOperation,
    projection: Pick<Alpha2MutableProjection, "readSession">,
  ): Promise<{
    readonly session: { readonly [key: string]: JsonValue };
    readonly appendedEvents: readonly JsonValue[];
    readonly alreadyApplied: boolean;
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
    const sessionEvents = session.events as readonly JsonValue[];
    const payloadEvents = payload.events as readonly JsonValue[];
    const currentRevision = sessionEvents.length;
    if (payloadEvents.length > 0) {
      const operationStartRevision = operation.nativeRevision - payloadEvents.length;
      if (operationStartRevision >= 0
        && currentRevision >= operationStartRevision
        && currentRevision <= operation.nativeRevision) {
        const alreadyAppliedCount = currentRevision - operationStartRevision;
        const projectedPrefix = sessionEvents.slice(operationStartRevision, currentRevision);
        const operationPrefix = payloadEvents.slice(0, alreadyAppliedCount);
        if (projectedPrefix.length === operationPrefix.length
          && projectedPrefix.every((event, index) => isDeepStrictEqual(event, operationPrefix[index]))) {
          const appendedEvents = payloadEvents.slice(alreadyAppliedCount);
          appendedEvents.forEach((eventValue, index) => {
            const event = record(eventValue, "Alpha2 append event");
            if (event.seq !== currentRevision + index) {
              throw new Error(`Alpha2 append event sequence is not contiguous: ${String(event.seq)}`);
            }
          });
          return { session, appendedEvents, alreadyApplied: appendedEvents.length === 0 };
        }
      }
    }
    if (operation.nativeRevision !== currentRevision + payloadEvents.length) {
      throw new Error(`Alpha2 native revision mismatch: ${currentRevision} -> ${operation.nativeRevision}`);
    }
    payloadEvents.forEach((eventValue, index) => {
      const event = record(eventValue, "Alpha2 append event");
      if (event.seq !== currentRevision + index) {
        throw new Error(`Alpha2 append event sequence is not contiguous: ${String(event.seq)}`);
      }
    });
    return { session, appendedEvents: payloadEvents, alreadyApplied: false };
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
