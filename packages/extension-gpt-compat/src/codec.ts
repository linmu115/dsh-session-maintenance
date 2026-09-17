import { createSessionFormatCatalog, snapshotSessionFormatJson, type SessionFormatArtifact, type SessionFormatEvent } from "@deepseek-ai/dsh-session-format";
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from "@deepseek-ai/dsh-session-format-v0-to-v1";
import { releasedV2SessionFormatCodec, sessionFormatV1ToV2 } from "@deepseek-ai/dsh-session-format-v1-to-v2";
import { releasedV3SessionFormatCodec, restoreReleasedV3Artifact, assertReleasedV3Header, sessionFormatV2ToV3 } from "@deepseek-ai/dsh-session-format-v2-to-v3";
import { Session, SessionId, SessionLogOffset, KNOWN_SESSION_EVENT_TYPES, type SessionHeader, type SessionEvent } from "@deepseek-ai/dsh-session";

export const PLUGIN_EVENTS = new Set(["context/checkpoint", "context/checkpoint-commit", "context/operation", "context/operation-result", "request/projection"]);
export const knownEventTypes: ReadonlySet<string> = new Set([...KNOWN_SESSION_EVENT_TYPES, ...PLUGIN_EVENTS]);
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
function fail(): never { throw new TypeError("Invalid GPT compatibility session event"); }

/** Validate the plugin-owned vocabulary; opaque payloads stay lossless JSON. */
export function validatePluginEvent(event: SessionFormatEvent): void {
  if (!PLUGIN_EVENTS.has(event.type)) return;
  snapshotSessionFormatJson(event, "GPT session event");
  if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined || event.ignorable !== undefined) fail();
  const d = event.data;
  if (!object(d)) fail();
  if (event.type === "context/checkpoint" && (!nonempty(d.key) || !Object.hasOwn(d, "state"))) fail();
  if (event.type === "context/operation" && (!["native-compact", "portable-summary"].includes(String(d.kind)) || !object(d.request))) fail();
  if (event.type === "context/checkpoint-commit" || event.type === "context/operation-result") {
    const ref = event.type === "context/checkpoint-commit" ? d.checkpoint : d.operation;
    if (!Number.isSafeInteger(ref) || Number(ref) < 0 || Number(ref) >= event.seq) fail();
    if (event.type === "context/operation-result" && !Object.hasOwn(d, "output")) fail();
  }
  if (event.type === "request/projection") {
    if (d.messages !== null && !Array.isArray(d.messages)) fail();
    if (Array.isArray(d.messages)) for (const m of d.messages) {
      if (!object(m) || !nonempty(m.id) || !["system", "user", "assistant"].includes(String(m.role))
        || !Array.isArray(m.content) || !object(m.source) || !nonempty(m.source.kind)) fail();
    }
    if (d.adapterContext !== undefined) {
      const a = d.adapterContext;
      if (d.messages === null || !object(a) || !nonempty(a.format) || !nonempty(a.scope) || !Array.isArray(a.input)) fail();
    }
  }
}
function restore(artifact: SessionFormatArtifact): SessionFormatArtifact {
  const restored = restoreReleasedV3Artifact(artifact, knownEventTypes);
  for (const e of restored.events) {
    validatePluginEvent(e);
    if (e.type === "context/checkpoint-commit" || e.type === "context/operation-result") {
      const d = e.data as Record<string, number>;
      const checkpoint = e.type === "context/checkpoint-commit";
      if (restored.events[(checkpoint ? d.checkpoint : d.operation)!]?.type !== (checkpoint ? "context/checkpoint" : "context/operation")) fail();
    }
  }
  Session.fromRestore(SessionId(restored.header.id), restored.events as SessionEvent[], restored.header as unknown as SessionHeader, SessionLogOffset(restored.inheritedEventCount), "detached");
  return restored;
}
/** Frozen released framing plus a separately owned logical vocabulary. No global host substitution. */
export const catalog = createSessionFormatCatalog({ currentVersion: 3,
  codecs: [releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, releasedV2SessionFormatCodec, releasedV3SessionFormatCodec],
  currentEncoder: { ...releasedV3SessionFormatCodec, encodeEvent(event) { validatePluginEvent(event); return releasedV3SessionFormatCodec.encodeEvent(event); } },
  migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3],
  restoreCurrent: restore, restoreTransformedCurrent: restore,
  restoreCurrentHeader(header) { assertReleasedV3Header(header); Session.fromRestore(SessionId(header.id), [], header as unknown as SessionHeader, SessionLogOffset(0), "detached"); return header; },
});
