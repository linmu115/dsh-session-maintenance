import type {
  AdapterProbeResult,
  AdapterVerificationResult,
  CanonicalAppendOperation,
  CanonicalProjectionInput,
  DshEnvironmentDescriptor,
  DshRuntimeBridgeV1,
  DshSessionAdapterV1,
  NativeAppendOperation,
  NativeReferenceResolution,
  ProjectionInspection,
  ProjectionManifest,
  ProjectionReader,
  ProjectionWriter,
  RuntimeAttachContext,
  RuntimeDrainResult,
  StableSessionReference,
} from "@linmu/dsh-session-contracts";

import { negotiateAdapterManifest } from "./manifest.js";

export interface AdapterCoreSmokeInput {
  readonly adapter: DshSessionAdapterV1;
  readonly bridge: DshRuntimeBridgeV1;
  readonly environment: DshEnvironmentDescriptor;
  readonly projection: CanonicalProjectionInput;
  readonly writer: ProjectionWriter;
  readonly reader: ProjectionReader;
  readonly append: NativeAppendOperation;
  readonly attach: RuntimeAttachContext;
  readonly reference: StableSessionReference;
}

export interface AdapterCoreSmokeResult {
  readonly ok: true;
  readonly probe: AdapterProbeResult;
  readonly projection: ProjectionManifest;
  readonly inspection: ProjectionInspection;
  readonly verification: AdapterVerificationResult;
  readonly append: CanonicalAppendOperation;
  readonly reference: NativeReferenceResolution;
  readonly drain: RuntimeDrainResult;
}

export async function runAdapterCoreSmoke(
  input: AdapterCoreSmokeInput,
): Promise<AdapterCoreSmokeResult> {
  const negotiation = negotiateAdapterManifest(input.adapter.manifest);
  if (!negotiation.ok) {
    throw new Error(negotiation.issues[0]?.message ?? "Adapter manifest negotiation failed");
  }
  if (input.projection.sessions.length !== 1) {
    throw new TypeError("Core Smoke requires exactly one canonical session");
  }
  if (input.projection.run.adapterId !== input.adapter.manifest.id) {
    throw new TypeError("Projection run and Adapter manifest IDs do not match");
  }
  const probe = await input.adapter.probe(input.environment);
  if (probe.status === "failed") {
    throw new Error("Adapter probe failed Core Smoke");
  }
  if (probe.manifest.id !== input.adapter.manifest.id) {
    throw new Error("Adapter probe returned another manifest identity");
  }
  const projection = await input.adapter.materialize(input.projection, input.writer);
  if (
    projection.runId !== input.projection.run.id ||
    projection.adapterId !== input.adapter.manifest.id ||
    projection.sessionCount !== 1
  ) {
    throw new Error("Adapter materialization manifest failed Core Smoke identity checks");
  }
  const inspection = await input.adapter.inspect(input.reader);
  if (inspection.sessionCount !== 1) {
    throw new Error("Adapter inspection did not find the one Core Smoke session");
  }
  const verification = await input.adapter.verify(projection, inspection);
  if (!verification.ok) throw new Error("Adapter projection verification failed Core Smoke");
  const append = await input.adapter.normalizeAppend(input.append);
  if (
    append.runId !== input.append.runId ||
    append.operationId !== input.append.operationId ||
    append.nativeSessionId !== input.append.nativeSessionId
  ) {
    throw new Error("Normalized append changed its operation identity");
  }
  const reference = await input.adapter.resolveReference(input.reference, input.projection.run);
  if (reference.logicalSessionId !== input.reference.logicalSessionId) {
    throw new Error("Reference resolution changed logical session identity");
  }
  const handle = await input.bridge.attach(input.attach);
  if (handle.runId !== input.projection.run.id || handle.adapterId !== input.adapter.manifest.id) {
    throw new Error("Runtime Bridge attached a different run or Adapter");
  }
  let drain: RuntimeDrainResult;
  try {
    drain = await input.bridge.drain(handle);
  } finally {
    await input.bridge.detach(handle);
  }
  if (drain.runId !== input.projection.run.id || drain.pendingOperations !== 0) {
    throw new Error("Runtime Bridge did not drain the Core Smoke run");
  }
  return {
    ok: true,
    probe,
    projection,
    inspection,
    verification,
    append,
    reference,
    drain,
  };
}
