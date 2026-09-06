import {
  CONTRACT_SCHEMA_VERSION,
  type AttachmentRef,
  type CompatibilityReport,
  type JsonValue,
  type NormalizedEvent,
  type NormalizedSession,
  type PlatformSessionKey,
  type Provenance,
} from "@linmu/dsh-session-contracts";

import { canonicalJson, sha256Canonical } from "./canonical-json.js";

export interface RawSessionEvent {
  readonly sourceEventId: string;
  readonly parentSourceEventId: string | null;
  readonly sequence: number;
  readonly kind: NormalizedEvent["kind"];
  readonly role: NormalizedEvent["role"];
  readonly content: string;
  readonly attachments: readonly AttachmentRef[];
  readonly extensions: Readonly<Record<string, JsonValue>>;
}

export interface NormalizationInput {
  readonly key: PlatformSessionKey;
  readonly title: string;
  readonly archived: boolean;
  readonly workspaceId: string | null;
  readonly provenance: Provenance;
  readonly compatibility: CompatibilityReport;
  readonly events: readonly RawSessionEvent[];
  readonly observedPath?: string;
  readonly observedPid?: number;
  readonly observedPort?: number;
  readonly logLocation?: string;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function assertMatchingSource(key: PlatformSessionKey, provenance: Provenance): void {
  if (
    key.platform !== provenance.platform ||
    key.instanceId !== provenance.instanceId ||
    key.sessionId !== provenance.sessionId
  ) {
    throw new TypeError("Normalization key and provenance must identify the same platform session");
  }
}

function eventIdentity(
  key: PlatformSessionKey,
  event: RawSessionEvent,
): JsonValue {
  return {
    source: {
      platform: key.platform,
      instanceId: key.instanceId,
      sessionId: key.sessionId,
      eventId: event.sourceEventId,
      sequence: event.sequence,
    },
    parentSourceEventId: event.parentSourceEventId,
    kind: event.kind,
    role: event.role,
    content: event.content,
    attachments: event.attachments.map((attachment) => ({
      name: attachment.name,
      ...(attachment.mediaType === undefined ? {} : { mediaType: attachment.mediaType }),
      source: attachment.source,
    })),
    extensions: event.extensions,
  };
}

function normalizedEventForHash(event: NormalizedEvent): JsonValue {
  return {
    id: event.id,
    parentId: event.parentId,
    sequence: event.sequence,
    kind: event.kind,
    role: event.role,
    content: event.content,
    attachments: event.attachments.map((attachment) => ({
      name: attachment.name,
      ...(attachment.mediaType === undefined ? {} : { mediaType: attachment.mediaType }),
      source: attachment.source,
    })),
    source: {
      platform: event.source.platform,
      instanceId: event.source.instanceId,
      sessionId: event.source.sessionId,
      ...(event.source.eventId === undefined ? {} : { eventId: event.source.eventId }),
      sequence: event.source.sequence,
    },
    extensions: event.extensions,
  };
}

/** The persisted normalized-body and metadata identity, shared by producers and readers. */
export function normalizedSessionHashes(
  input: Pick<NormalizedSession, "schemaVersion" | "workspaceId" | "events" | "title" | "archived">,
): Pick<NormalizedSession, "bodyHash" | "metadataHash"> {
  return {
    bodyHash: sha256Canonical({
      schemaVersion: input.schemaVersion,
      workspaceId: input.workspaceId,
      events: input.events.map(normalizedEventForHash),
    }),
    metadataHash: sha256Canonical({ title: input.title, archived: input.archived }),
  };
}

export function normalizeSession(input: NormalizationInput): NormalizedSession {
  assertMatchingSource(input.key, input.provenance);

  const eventIds = new Map<string, string>();
  for (const event of input.events) {
    if (!event.sourceEventId) {
      throw new TypeError("Every source event requires a stable sourceEventId");
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
      throw new TypeError("Event sequence must be a non-negative safe integer");
    }
    if (eventIds.has(event.sourceEventId)) {
      throw new TypeError(`Duplicate source event ID: ${event.sourceEventId}`);
    }

    eventIds.set(event.sourceEventId, `ev_${sha256Canonical(eventIdentity(input.key, event)).slice(0, 24)}`);
  }

  const events: NormalizedEvent[] = input.events.map((event) => {
    const id = eventIds.get(event.sourceEventId);
    if (id === undefined) {
      throw new TypeError(`Missing normalized event ID: ${event.sourceEventId}`);
    }

    const parentId =
      event.parentSourceEventId === null ? null : eventIds.get(event.parentSourceEventId);
    if (parentId === undefined) {
      throw new TypeError(`Missing parent source event: ${event.parentSourceEventId}`);
    }
    if (parentId === id) {
      throw new TypeError(`Event cannot be its own parent: ${event.sourceEventId}`);
    }

    return {
      id,
      parentId,
      sequence: event.sequence,
      kind: event.kind,
      role: event.role,
      content: event.content,
      attachments: event.attachments.map((attachment) => ({ ...attachment })),
      source: {
        ...input.key,
        eventId: event.sourceEventId,
        sequence: event.sequence,
      },
      extensions: cloneJson(event.extensions),
    };
  });

  const { bodyHash, metadataHash } = normalizedSessionHashes({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    events,
    title: input.title,
    archived: input.archived,
  });

  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    key: { ...input.key },
    title: input.title,
    archived: input.archived,
    workspaceId: input.workspaceId,
    events,
    bodyHash,
    metadataHash,
    provenance: { ...input.provenance },
    compatibility: {
      status: input.compatibility.status,
      issues: input.compatibility.issues.map((issue) => ({ ...issue })),
    },
  };
}
