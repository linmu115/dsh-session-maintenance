import {
  SessionMaintenanceError,
  type JsonValue,
  type NormalizedEvent,
} from "@linmu/dsh-session-contracts";
import type {
  DshCoreSnapshot,
  DshNativeEvent,
  DshNativeSessionHeader,
} from "@linmu/dsh-core-extension";
import { sha256Canonical } from "@linmu/dsh-session-domain";

export interface DshEventPreparationRequest {
  readonly planHash: string;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly create: boolean;
  readonly sourceEvents: readonly NormalizedEvent[];
  readonly title?: string;
  readonly snapshot: DshCoreSnapshot;
}

export interface DshEventPreparation {
  readonly header?: DshNativeSessionHeader;
  readonly events: readonly DshNativeEvent[];
}

function textBlock(content: string): JsonValue {
  return [{ type: "text", text: content }];
}

function messageId(planHash: string, event: NormalizedEvent): string {
  return `maintenance_${sha256Canonical({ planHash, eventId: event.id, role: event.role }).slice(0, 24)}`;
}

function stringExtension(event: NormalizedEvent, key: string, fallback: string): string {
  const value = event.extensions[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lastTurn(snapshot: DshCoreSnapshot): number {
  if (!snapshot.session.exists) return -1;
  let result = -1;
  for (const event of snapshot.session.events) {
    if (event.type !== "turn/start") continue;
    const data = event.data;
    if (
      isJsonObject(data) &&
      typeof data.turn === "number" &&
      Number.isSafeInteger(data.turn)
    ) {
      result = Math.max(result, data.turn);
    }
  }
  return result;
}

function validateSourceEvent(event: NormalizedEvent): void {
  if (
    event.kind !== "message" ||
    !["user", "assistant"].includes(event.role) ||
    event.attachments.length > 0
  ) {
    throw new SessionMaintenanceError(
      "WRITE_CAPABILITY_UNAVAILABLE",
      `Unsupported normalized event cannot be written to DSH: ${event.id}`,
    );
  }
}

export function validateDshSourceEvents(events: readonly NormalizedEvent[]): void {
  for (const event of events) validateSourceEvent(event);
  let waitingForAssistant = false;
  for (const event of events) {
    if (event.role === "user") {
      waitingForAssistant = true;
      continue;
    }
    if (!waitingForAssistant) {
      throw new SessionMaintenanceError(
        "WRITE_CAPABILITY_UNAVAILABLE",
        `Assistant import has no preceding user message: ${event.id}`,
      );
    }
    waitingForAssistant = false;
  }
}

export function prepareDshEvents(request: DshEventPreparationRequest): DshEventPreparation {
  validateDshSourceEvents(request.sourceEvents);
  const createdAt = Date.parse(request.createdAt);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new SessionMaintenanceError("WRITE_CAPABILITY_UNAVAILABLE", "DSH event timestamp is invalid");
  }
  const events: DshNativeEvent[] = [];
  let seq = request.snapshot.session.exists ? request.snapshot.session.events.length : 0;
  let time = Math.max(
    createdAt,
    request.snapshot.session.exists
      ? Math.max(request.snapshot.session.header.createdAt, ...request.snapshot.session.events.map((event) => event.time))
      : 0,
  );
  let turn = lastTurn(request.snapshot) + 1;

  const push = (type: string, data: JsonValue, surfaceOp?: "append"): void => {
    events.push({
      type,
      seq,
      time,
      data,
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
    });
    seq += 1;
    time += 1;
  };

  for (let index = 0; index < request.sourceEvents.length;) {
    const user = request.sourceEvents[index];
    if (user === undefined || user.role !== "user") {
      throw new SessionMaintenanceError(
        "WRITE_CAPABILITY_UNAVAILABLE",
        `Imported DSH turn must begin with a user message: ${user?.id ?? "missing"}`,
      );
    }
    const assistant = request.sourceEvents[index + 1]?.role === "assistant"
      ? request.sourceEvents[index + 1]
      : undefined;
    push("turn/start", { turn });
    push("step/start", { turn, step: 0 });
    push(
      "user/message",
      {
        id: messageId(request.planHash, user),
        role: "user",
        content: textBlock(user.content),
        source: { kind: "user" },
      },
      "append",
    );
    if (assistant !== undefined) {
      push(
        "assistant/message",
        {
          turn,
          step: 0,
          message: {
            id: messageId(request.planHash, assistant),
            role: "assistant",
            content: textBlock(assistant.content),
            source: {
              kind: "model",
              provider: stringExtension(assistant, "provider", "maintenance-import"),
              model: stringExtension(assistant, "model", "imported"),
            },
          },
        },
        "append",
      );
    }
    push("step/end", { turn, step: 0 });
    push("turn/end", { turn, reason: { kind: "completed" } });
    index += assistant === undefined ? 1 : 2;
    turn += 1;
  }

  if (request.title !== undefined) {
    const title = request.title.trim().replace(/\s+/gu, " ");
    if (title.length === 0) {
      throw new SessionMaintenanceError("WRITE_CAPABILITY_UNAVAILABLE", "DSH title is empty");
    }
    push("session/title", { title, messageSeqs: [], source: { kind: "user" } });
  }

  return {
    ...(request.create
      ? {
          header: {
            version: 0,
            id: request.sessionId,
            createdAt,
            delegationDepth: 0,
          },
        }
      : {}),
    events,
  };
}
