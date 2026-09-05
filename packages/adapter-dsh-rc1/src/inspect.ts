import type {
  AdapterVerificationResult,
  JsonValue,
  ProjectionInspection,
  ProjectionManifest,
  ProjectionReader,
} from "@linmu/dsh-session-adapter-sdk";

import { catalogDigest, digest, type Rc1ProjectionSession } from "./materialize.js";

const CORE_EVENT_TYPES = new Set([
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "user/message",
  "assistant/chunk",
  "assistant/message",
  "tool/call",
  "tool/result",
  "request/header",
  "request/context",
  "session/end-seed",
]);

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePayload(value: JsonValue): Rc1ProjectionSession {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.header) || !Array.isArray(value.events)) {
    throw new TypeError("Rc1 projection session payload is invalid");
  }
  if (value.header.isSeeded !== false || value.inheritedEventCount !== 0) {
    throw new TypeError("Rc1 Maintenance projection must use an unseeded SessionHeader with offset zero");
  }
  return value as unknown as Rc1ProjectionSession;
}

function integerField(
  data: JsonValue,
  field: "turn" | "step",
  eventType: string,
): number {
  if (!isRecord(data) || !Number.isSafeInteger(data[field])) {
    throw new TypeError(`Rc1 ${eventType} has no valid ${field}`);
  }
  return data[field] as number;
}

function requireOpenStep(
  event: Rc1ProjectionSession["events"][number],
  openTurn: number | null,
  openStep: number | null,
): void {
  const turn = integerField(event.data, "turn", event.type);
  const step = integerField(event.data, "step", event.type);
  if (turn !== openTurn || step !== openStep) {
    throw new TypeError(
      `Rc1 ${event.type} names turn ${turn}/step ${step} but open is turn ${String(openTurn)}/step ${String(openStep)} (seq ${event.seq})`,
    );
  }
}

/** Exact relational subset published by @deepseek-ai/dsh-session 0.1.2-rc.1. */
export function assertRc1SessionInvariants(events: Rc1ProjectionSession["events"]): void {
  let lastSeq = -1;
  let nextTurn = 1;
  let nextStep = 1;
  let openTurn: number | null = null;
  let openStep: number | null = null;
  const pendingCalls = new Set<string>();
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= lastSeq) {
      throw new TypeError(`Rc1 seq must strictly increase: saw ${event.seq} after ${lastSeq}`);
    }
    lastSeq = event.seq;
    if (event.type === "turn/start") {
      const turn = integerField(event.data, "turn", event.type);
      if (openTurn !== null) throw new TypeError(`Rc1 turn/start ${turn} while turn ${openTurn} is open`);
      if (turn !== nextTurn) throw new TypeError(`Rc1 turn/start expected ${nextTurn}, got ${turn}`);
      openTurn = turn;
      nextStep = 1;
      continue;
    }
    if (event.type === "turn/end") {
      const turn = integerField(event.data, "turn", event.type);
      if (turn !== openTurn) throw new TypeError(`Rc1 turn/end ${turn} does not match open turn ${String(openTurn)}`);
      if (openStep !== null) throw new TypeError(`Rc1 turn/end ${turn} while step ${openStep} is open`);
      openTurn = null;
      nextTurn += 1;
      continue;
    }
    if (event.type === "step/start") {
      const turn = integerField(event.data, "turn", event.type);
      const step = integerField(event.data, "step", event.type);
      if (turn !== openTurn) throw new TypeError(`Rc1 step/start turn ${turn} does not match ${String(openTurn)}`);
      if (openStep !== null) throw new TypeError(`Rc1 step/start ${step} while step ${openStep} is open`);
      if (step !== nextStep) throw new TypeError(`Rc1 step/start expected ${nextStep}, got ${step}`);
      openStep = step;
      continue;
    }
    if (event.type === "step/end") {
      requireOpenStep(event, openTurn, openStep);
      pendingCalls.clear();
      openStep = null;
      nextStep += 1;
      continue;
    }
    if (event.type === "assistant/chunk" || event.type === "assistant/message") {
      requireOpenStep(event, openTurn, openStep);
      continue;
    }
    if (event.type === "tool/call") {
      requireOpenStep(event, openTurn, openStep);
      if (!isRecord(event.data) || typeof event.data.callId !== "string" || event.data.callId.length === 0) {
        throw new TypeError("Rc1 tool/call has no callId");
      }
      pendingCalls.add(event.data.callId);
      continue;
    }
    if (event.type === "tool/result") {
      if (event.surfaceOp !== "append") {
        if (openTurn === null) throw new TypeError("Rc1 replacement tool/result is outside a turn");
        continue;
      }
      requireOpenStep(event, openTurn, openStep);
      const message = isRecord(event.data) && isRecord(event.data.message) ? event.data.message : undefined;
      const source = isRecord(message?.source) ? message.source : undefined;
      const callId = typeof source?.callId === "string" ? source.callId : null;
      if (callId === null || !pendingCalls.has(callId)) {
        throw new TypeError(`Rc1 tool/result has no pending tool/call for ${String(callId)}`);
      }
      pendingCalls.delete(callId);
      continue;
    }
    if ((event.type === "request/header" || event.type === "request/context") && openTurn === null) {
      throw new TypeError(`Rc1 ${event.type} is outside a turn`);
    }
  }
}

export async function inspectRc1(reader: ProjectionReader): Promise<ProjectionInspection> {
  const ids = [...await reader.listNativeSessionIds()].sort();
  const sessionDigests: Record<string, string> = {};
  const workspaceReader = reader as ProjectionReader & {
    readonly listNativeWorkspaceIds?: () => Promise<readonly string[]>;
  };
  const workspaceIds: string[] = workspaceReader.listNativeWorkspaceIds === undefined
    ? []
    : [...await workspaceReader.listNativeWorkspaceIds()];
  const heldOut = new Set<string>();
  for (const id of ids) {
    const value = await reader.readSession(id);
    const payload = parsePayload(value);
    if (payload.header.id !== id) throw new TypeError(`Rc1 payload identity mismatch for ${id}`);
    try {
      assertRc1SessionInvariants(payload.events);
    } catch (error) {
      throw new TypeError(
        `Rc1 projection session ${payload.logicalSessionId} failed inspection: ${error instanceof Error ? error.message : "invalid native lifecycle"}`,
        { cause: error },
      );
    }
    sessionDigests[id] = digest(value);
    if (workspaceReader.listNativeWorkspaceIds === undefined && payload.workspaceId !== null) {
      workspaceIds.push(payload.workspaceId);
    }
    for (const event of payload.events) {
      if (!CORE_EVENT_TYPES.has(event.type)) heldOut.add(event.type);
    }
  }
  return {
    sessionCount: ids.length,
    workspaceCount: new Set(workspaceIds).size,
    catalogDigest: catalogDigest(sessionDigests, workspaceIds),
    sessionDigests,
    issues: [...heldOut].sort().map((type) => ({
      code: "RC1_EVENT_HELD_OUT",
      message: `Event type ${type} was preserved verbatim but is not interpreted by the Rc1 core codec`,
      sourceType: type,
    })),
  };
}

export function verifyRc1(
  expected: ProjectionManifest,
  actual: ProjectionInspection,
): AdapterVerificationResult {
  const expectedDigestEntries = Object.entries(expected.sessionDigests)
    .sort(([left], [right]) => left.localeCompare(right));
  const actualDigestEntries = Object.entries(actual.sessionDigests)
    .sort(([left], [right]) => left.localeCompare(right));
  const digestsMatch = JSON.stringify(expectedDigestEntries) === JSON.stringify(actualDigestEntries);
  const ok = expected.sessionCount === actual.sessionCount
    && expected.workspaceCount === actual.workspaceCount
    && expected.catalogDigest === actual.catalogDigest
    && digestsMatch;
  return {
    ok,
    status: ok ? "verified" : "failed",
    issues: ok ? actual.issues : [{
      code: "RC1_PROJECTION_DIGEST_MISMATCH",
      message: "The inspected Rc1 projection does not match its materialization manifest",
    }, ...actual.issues],
  };
}
