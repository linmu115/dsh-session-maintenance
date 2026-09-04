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
import {
  parseRc1LogicalSessionHeader,
  parseRc1RegistrationMetadata,
  validateRc1Lineage,
} from "./lineage.js";
import { rc1SessionLogOffset } from "./native-types.js";

export interface Rc1RuntimeRegistration {
  readonly registrationId: string;
  readonly attachedAt: string;
}

export interface Rc1RuntimeRegistrar {
  attach(input: {
    readonly runId: RunId;
    readonly maintenanceEndpoint: string;
  }): Promise<Rc1RuntimeRegistration>;
  drain(registrationId: string, runId: RunId): Promise<RuntimeDrainResult>;
  drainSession?(registrationId: string, runId: RunId, nativeSessionId: NativeAppendOperation["nativeSessionId"]): Promise<RuntimeDrainResult>;
  hideSession?(registrationId: string, runId: RunId, nativeSessionId: NativeAppendOperation["nativeSessionId"]): Promise<void>;
  detach(registrationId: string, runId: RunId): Promise<void>;
}

export interface Rc1MutableProjection {
  readSession(nativeSessionId: NativeAppendOperation["nativeSessionId"]): Promise<JsonValue>;
  replaceSession(nativeSessionId: NativeAppendOperation["nativeSessionId"], payload: JsonValue): Promise<void>;
  writeSession?(nativeSessionId: NativeAppendOperation["nativeSessionId"], payload: JsonValue): Promise<void>;
}

export type Rc1AppendHandler = (
  operation: NativeAppendOperation,
) => Promise<ProjectionOperationReceipt>;

function record(value: JsonValue, description: string): { readonly [key: string]: JsonValue } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value as { readonly [key: string]: JsonValue };
}

export class Rc1RuntimeBridge implements DshRuntimeBridgeV1 {
  readonly registrar: Rc1RuntimeRegistrar;
  private readonly registrations = new Map<RunId, Rc1RuntimeRegistration>();
  private readonly appendHandlers = new Map<RunId, Rc1AppendHandler>();
  private readonly drainingRuns = new Set<RunId>();

  constructor(registrar: Rc1RuntimeRegistrar) {
    this.registrar = registrar;
  }

  async attach(context: RuntimeAttachContext): Promise<RuntimeHandle> {
    if (this.registrations.has(context.run.id)) {
      throw new Error(`Rc1 runtime is already attached for ${context.run.id}`);
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
    if (this.registrar.hideSession === undefined) throw new Error("Rc1 runtime registrar cannot hide a projected session");
    await this.registrar.hideSession(registration.registrationId, handle.runId, nativeSessionId);
  }

  async bindAppendHandler(handle: RuntimeHandle, handler: Rc1AppendHandler): Promise<void> {
    this.registration(handle);
    if (this.appendHandlers.has(handle.runId)) {
      throw new Error(`Rc1 append handler is already bound for ${handle.runId}`);
    }
    this.appendHandlers.set(handle.runId, handler);
  }

  async submitAppend(operation: NativeAppendOperation): Promise<ProjectionOperationReceipt> {
    if (this.drainingRuns.has(operation.runId)) {
      throw new Error(`Rc1 runtime is draining and rejects new appends for ${operation.runId}`);
    }
    const handler = this.appendHandlers.get(operation.runId);
    if (handler === undefined) throw new Error(`Rc1 append handler is not bound for ${operation.runId}`);
    return handler(operation);
  }

  async applyAppend(
    handle: RuntimeHandle,
    operation: NativeAppendOperation,
    projection: Rc1MutableProjection,
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
    projection: Rc1MutableProjection,
  ): Promise<void> {
    this.registration(handle);
    if (projection.writeSession === undefined) throw new Error("Rc1 projection cannot register a new native session");
    const header = parseRc1LogicalSessionHeader(
      registration.header,
      registration.nativeSessionId,
      "RC1 new SessionHeader",
    );
    const inheritedEventCount = registration.adapterMetadata === undefined && !header.isSeeded
      ? rc1SessionLogOffset(0)
      : parseRc1RegistrationMetadata(registration.adapterMetadata);
    validateRc1Lineage(header, inheritedEventCount);
    const expected = {
      schemaVersion: 1,
      logicalSessionId: registration.logicalSessionId,
      baseVersionId: null,
      workspaceId: registration.workspaceId,
      projectId: registration.projectId,
      updatedAt: new Date(header.createdAt).toISOString(),
      title: registration.title,
      tags: [],
      inheritedEventCount,
      header,
      events: [],
    } as const;
    try {
      const existing = await projection.readSession(registration.nativeSessionId);
      if (!isDeepStrictEqual(existing, expected)) {
        throw new Error(`Rc1 native registration payload already exists with different content: ${registration.nativeSessionId}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await projection.writeSession(registration.nativeSessionId, expected);
    }
  }

  async validateAppend(
    handle: RuntimeHandle,
    operation: NativeAppendOperation,
    projection: Pick<Rc1MutableProjection, "readSession">,
  ): Promise<{
    readonly session: { readonly [key: string]: JsonValue };
    readonly appendedEvents: readonly JsonValue[];
    readonly alreadyApplied: boolean;
  }> {
    this.registration(handle);
    if (handle.runId !== operation.runId) throw new Error("Rc1 append belongs to another runtime handle");
    const session = record(await projection.readSession(operation.nativeSessionId), "Rc1 projection session");
    const payload = record(operation.payload, "Rc1 append payload");
    if (session.logicalSessionId !== payload.logicalSessionId) {
      throw new Error("Rc1 append logical session does not match the projection");
    }
    if (!Array.isArray(session.events) || !Array.isArray(payload.events)) {
      throw new TypeError("Rc1 session and append require event arrays");
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
            const event = record(eventValue, "Rc1 append event");
            if (event.seq !== currentRevision + index) {
              throw new Error(`Rc1 append event sequence is not contiguous: ${String(event.seq)}`);
            }
          });
          return { session, appendedEvents, alreadyApplied: appendedEvents.length === 0 };
        }
      }
    }
    if (operation.nativeRevision !== currentRevision + payloadEvents.length) {
      throw new Error(`Rc1 native revision mismatch: ${currentRevision} -> ${operation.nativeRevision}`);
    }
    payloadEvents.forEach((eventValue, index) => {
      const event = record(eventValue, "Rc1 append event");
      if (event.seq !== currentRevision + index) {
        throw new Error(`Rc1 append event sequence is not contiguous: ${String(event.seq)}`);
      }
    });
    return { session, appendedEvents: payloadEvents, alreadyApplied: false };
  }

  async switchLogicalSession(
    handle: RuntimeHandle,
    nativeSessionId: NativeAppendOperation["nativeSessionId"],
    logicalSessionId: LogicalSessionId,
    baseVersionId: SessionVersionId | null,
    projection: Rc1MutableProjection,
  ): Promise<void> {
    this.registration(handle);
    const session = record(await projection.readSession(nativeSessionId), "Rc1 projection session");
    await projection.replaceSession(nativeSessionId, {
      ...session,
      logicalSessionId,
      baseVersionId,
    });
  }

  private registration(handle: RuntimeHandle): Rc1RuntimeRegistration {
    if (handle.adapterId !== manifest.id) throw new Error("Runtime handle belongs to another Adapter");
    const registration = this.registrations.get(handle.runId);
    if (registration === undefined) throw new Error(`Rc1 runtime is not attached for ${handle.runId}`);
    return registration;
  }
}
