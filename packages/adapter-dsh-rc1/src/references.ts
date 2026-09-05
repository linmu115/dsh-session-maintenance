import type {
  NativeReferenceResolution,
  JsonValue,
  NativeSessionId,
  ProjectionReader,
  ProjectionRun,
  StableSessionReference,
} from "@linmu/dsh-session-adapter-sdk";

import { rc1NativeSessionId } from "./materialize.js";

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function resolveRc1Reference(
  reference: StableSessionReference,
  _run: ProjectionRun,
  reader?: ProjectionReader,
): Promise<NativeReferenceResolution> {
  const nativeSessionId = (reference.legacyNativeSessionId
    ?? rc1NativeSessionId(reference.logicalSessionId)) as NativeSessionId;
  const unavailable: NativeReferenceResolution = {
    logicalSessionId: reference.logicalSessionId,
    nativeSessionId: null,
    nativeAnchorId: null,
    status: "unavailable",
  };
  if (nativeSessionId.trim().length === 0) return unavailable;
  if (reader === undefined) {
    return reference.logicalAnchorId === null ? {
      logicalSessionId: reference.logicalSessionId,
      nativeSessionId,
      nativeAnchorId: null,
      status: "resolved",
    } : unavailable;
  }
  let payload: JsonValue;
  try {
    payload = await reader.readSession(nativeSessionId);
  } catch {
    return unavailable;
  }
  if (!isRecord(payload) || payload.logicalSessionId !== reference.logicalSessionId
    || !isRecord(payload.header) || payload.header.id !== nativeSessionId || !Array.isArray(payload.events)) {
    return unavailable;
  }
  let nativeAnchorId = reference.logicalAnchorId;
  if (nativeAnchorId !== null) {
    if (nativeAnchorId.trim().length === 0) return unavailable;
    const aliases = isRecord(payload.anchorAliases) ? payload.anchorAliases : undefined;
    if (aliases !== undefined && Object.hasOwn(aliases, nativeAnchorId)) {
      const target = aliases[nativeAnchorId];
      if (typeof target !== "string" || target.trim().length === 0) return unavailable;
      nativeAnchorId = target;
    }
    // Append-origin messages remain the human transcript even when a later
    // model-only surface replacement shadows them.
    let matches = 0;
    for (const value of payload.events) {
      if (!isRecord(value) || value.surfaceOp !== "append" || !isRecord(value.data)) continue;
      const message = value.type === "user/message" ? value.data
        : (value.type === "assistant/message" || value.type === "tool/result") && isRecord(value.data.message)
          ? value.data.message : undefined;
      if (message?.id === reference.logicalAnchorId && nativeAnchorId !== reference.logicalAnchorId) return unavailable;
      if (message?.id === nativeAnchorId) matches += 1;
    }
    if (matches !== 1) return unavailable;
  }
  return {
    logicalSessionId: reference.logicalSessionId,
    nativeSessionId,
    nativeAnchorId,
    status: "resolved",
  };
}
