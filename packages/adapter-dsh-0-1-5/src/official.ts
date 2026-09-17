import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import { Session, SessionId, SessionLogOffset, KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import { currentDialect } from "./dialect.js";
import type { SessionFormatArtifact, SessionFormatEvent } from "@deepseek-ai/dsh-session-format";
export { sessionFormatCatalog, KNOWN_SESSION_EVENT_TYPES };
export const currentCatalog = () => currentDialect()?.catalog ?? sessionFormatCatalog;
export const knownEventTypes = () => currentDialect()?.knownEventTypes ?? KNOWN_SESSION_EVENT_TYPES;
export function validateV3(artifact: SessionFormatArtifact): SessionFormatArtifact {
 const catalog = currentCatalog();
 const header = catalog.encodeCurrentHeader(artifact.header, artifact.inheritedEventCount);
 const restore = catalog.createRestore(header, { recovery: "strict", validation: "current" });
 for (const event of artifact.events) restore.decodeRow(catalog.encodeCurrentEvent(event));
 const actual = restore.finish();
 if (actual.inheritedEventCount !== artifact.inheritedEventCount) throw new TypeError("V3 inherited cut differs from end-seed marker");
 return actual;
}
export function validateV3Events(events: readonly SessionFormatEvent[]): void { for (const e of events) currentCatalog().encodeCurrentEvent(e); }
export function visibleContext(artifact: SessionFormatArtifact): unknown {
 const session = Session.fromRestore(SessionId(artifact.header.id), structuredClone(artifact.events) as never, artifact.header as never, SessionLogOffset(artifact.inheritedEventCount), "detached");
 return session.deriveMessages();
}
