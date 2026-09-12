import type {
  NativeReferenceResolution,
  JsonValue,
  NativeSessionId,
  ProjectionReader,
  ProjectionRun,
  StableSessionReference,
} from "@linmu/dsh-session-adapter-sdk";

import { v3NativeSessionId } from "./materialize.js";

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function resolveV3Reference(
  reference: StableSessionReference,
  _run: ProjectionRun,
  reader?: ProjectionReader,
): Promise<NativeReferenceResolution> {
  let nativeSessionId = v3NativeSessionId(reference.logicalSessionId);
  const unavailable: NativeReferenceResolution = {
    logicalSessionId: reference.logicalSessionId,
    nativeSessionId: null,
    nativeAnchorId: null,
    status: "unavailable",
  };
  if (nativeSessionId.trim().length === 0) return unavailable;
  if (reader === undefined) return unavailable;
  const candidates = [...new Set([nativeSessionId, reference.legacyNativeSessionId].filter((id): id is string => id !== null))];
  const matches: {id: NativeSessionId; payload: JsonValue}[] = [];
  for (const id of candidates) {
    try { const value = await reader.readSession(id as NativeSessionId);
      if (isRecord(value) && value.logicalSessionId === reference.logicalSessionId) matches.push({id:id as NativeSessionId,payload:value});
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return unavailable; }
  }
  if (matches.length !== 1) return unavailable;
  nativeSessionId = matches[0]!.id;
  const payload = matches[0]!.payload;
  if (!isRecord(payload) || payload.logicalSessionId !== reference.logicalSessionId
    || !isRecord(payload.header) || payload.header.id !== nativeSessionId || !Array.isArray(payload.events)) {
    return unavailable;
  }
  if (_run.adapterId !== "dsh-0.1.5" || payload.instanceId !== _run.instanceId || payload.profileId !== _run.profileId) return unavailable;
  if(reference.legacyNativeSessionId !== null && reference.legacyNativeSessionId !== nativeSessionId && (!Array.isArray(payload.legacyNativeSessionIds) || !payload.legacyNativeSessionIds.includes(reference.legacyNativeSessionId))) return unavailable;
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
        : (value.type === "assistant/message" || value.type === "tool/result" || value.type === "system/message") && isRecord(value.data.message)
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
