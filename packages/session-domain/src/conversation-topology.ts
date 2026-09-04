import {
  readCanonicalConversationTopologyV1,
  type CanonicalConversationPhase,
  type CanonicalConversationTopologyV1,
  type CanonicalEventKind,
  type CanonicalEventV1,
  type JsonValue,
} from "@linmu/dsh-session-contracts";

export type ConversationTopologyIssueCode =
  | "phase-mismatch"
  | "turn-identity-conflict"
  | "step-identity-conflict"
  | "missing-tool-call-id"
  | "missing-tool-result-id"
  | "duplicate-tool-call-id"
  | "orphan-tool-result"
  | "unclosed-tool-call";

export interface ConversationTopologyIssueV1 {
  readonly code: ConversationTopologyIssueCode;
  readonly eventIds: readonly string[];
  readonly callId: string | null;
}

export interface PlannedConversationEventV1 {
  readonly eventId: string;
  readonly sequence: number;
  readonly kind: CanonicalEventKind;
  readonly topology: CanonicalConversationTopologyV1;
}

export interface ConversationTopologyStepPlanV1 {
  readonly stepId: string;
  readonly stepOrdinal: number;
  readonly eventIds: readonly string[];
}

export interface ConversationTopologyTurnPlanV1 {
  readonly turnId: string;
  readonly turnOrdinal: number;
  readonly eventIds: readonly string[];
  readonly steps: readonly ConversationTopologyStepPlanV1[];
}

export interface ConversationContinuationEligibilityV1 {
  readonly status: "eligible" | "blocked";
  readonly reasons: readonly ConversationTopologyIssueV1[];
}

export interface ConversationTopologyDiagnosticsV1 {
  readonly inputEventCount: number;
  readonly conversationalEventCount: number;
  readonly unassignedEventCount: number;
  readonly turnCount: number;
  readonly stepCount: number;
  readonly toolCallCount: number;
  readonly matchedToolResultCount: number;
  readonly orphanToolResultCount: number;
  readonly unclosedToolCallCount: number;
  readonly topologyConflictCount: number;
}

export interface ConversationTopologyPlanV1 {
  readonly schemaVersion: 1;
  readonly events: readonly PlannedConversationEventV1[];
  readonly turns: readonly ConversationTopologyTurnPlanV1[];
  readonly continuationEligibility: ConversationContinuationEligibilityV1;
  readonly diagnostics: ConversationTopologyDiagnosticsV1;
}

interface MutableStep {
  readonly stepId: string;
  readonly stepOrdinal: number;
  readonly eventIds: string[];
}

interface MutableTurn {
  readonly turnId: string;
  readonly turnOrdinal: number;
  readonly eventIds: string[];
  readonly steps: MutableStep[];
  readonly stepsById: Map<string, MutableStep>;
}

interface Cursor {
  readonly turnId: string;
  readonly turnOrdinal: number;
  readonly stepId: string;
  readonly stepOrdinal: number;
}

interface PendingToolCall {
  readonly eventId: string;
  readonly turnId: string;
  readonly stepId: string | null;
}

function phaseForKind(kind: CanonicalEventKind): CanonicalConversationPhase | null {
  switch (kind) {
    case "user-message": return "user";
    case "reasoning": return "reasoning";
    case "assistant-message": return "assistant";
    case "tool-call": return "tool-call";
    case "tool-result": return "tool-result";
    default: return null;
  }
}

function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolCallId(event: CanonicalEventV1): string | null {
  if (!isJsonRecord(event.content)) return null;
  const value = event.content.callId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function derivedTurn(eventId: string, turnOrdinal: number): Cursor {
  const turnId = `mcsf-turn:${eventId}`;
  return {
    turnId,
    turnOrdinal,
    stepId: `${turnId}:step:0`,
    stepOrdinal: 0,
  };
}

function nextStep(cursor: Cursor): Cursor {
  const stepOrdinal = cursor.stepOrdinal + 1;
  return {
    ...cursor,
    stepId: `${cursor.turnId}:step:${stepOrdinal}`,
    stepOrdinal,
  };
}

function derivedTopology(
  cursor: Cursor,
  phase: CanonicalConversationPhase,
): CanonicalConversationTopologyV1 {
  return {
    schemaVersion: 1,
    turnId: cursor.turnId,
    turnOrdinal: cursor.turnOrdinal,
    stepId: cursor.stepId,
    stepOrdinal: cursor.stepOrdinal,
    phase,
    inference: "derived",
  };
}

function issue(
  code: ConversationTopologyIssueCode,
  eventIds: readonly string[],
  callId: string | null = null,
): ConversationTopologyIssueV1 {
  return { code, eventIds, callId };
}

/**
 * Produce a stable turn/step plan without changing, sorting or manufacturing
 * canonical events. Explicit MCSF topology wins; legacy events receive a
 * deterministic derived topology so old versions remain inspectable.
 */
export function planConversationTopology(
  inputEvents: readonly CanonicalEventV1[],
): ConversationTopologyPlanV1 {
  const plannedEvents: PlannedConversationEventV1[] = [];
  const issues: ConversationTopologyIssueV1[] = [];
  const turns: MutableTurn[] = [];
  const turnsById = new Map<string, MutableTurn>();
  const turnIdsByOrdinal = new Map<number, string>();
  const stepCoordinates = new Map<string, { readonly turnId: string; readonly stepOrdinal: number }>();
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const pendingToolCallsByStep = new Map<string, number>();
  const seenToolCallIds = new Set<string>();
  let cursor: Cursor | null = null;
  let highestTurnOrdinal = -1;
  let advanceBeforeNextModelPhase = false;
  let toolCallCount = 0;
  let missingToolCallIdCount = 0;
  let matchedToolResultCount = 0;
  let orphanToolResultCount = 0;
  let topologyConflictCount = 0;

  const addTopologyIssue = (value: ConversationTopologyIssueV1): void => {
    issues.push(value);
    topologyConflictCount += 1;
  };
  const pendingStepKey = (turnId: string, stepId: string | null): string => `${turnId}\u0000${stepId ?? ""}`;

  for (const event of inputEvents) {
    const phase = phaseForKind(event.kind);
    if (phase === null) continue;

    const explicit = readCanonicalConversationTopologyV1(event);
    let topology: CanonicalConversationTopologyV1;
    if (explicit !== null) {
      topology = explicit;
      highestTurnOrdinal = Math.max(highestTurnOrdinal, explicit.turnOrdinal);
      if (explicit.phase !== phase) {
        addTopologyIssue(issue("phase-mismatch", [event.id]));
      }
      if (explicit.stepId !== null && explicit.stepOrdinal !== null) {
        cursor = {
          turnId: explicit.turnId,
          turnOrdinal: explicit.turnOrdinal,
          stepId: explicit.stepId,
          stepOrdinal: explicit.stepOrdinal,
        };
      } else {
        cursor = null;
      }
      advanceBeforeNextModelPhase = false;
    } else {
      if (phase === "user" || cursor === null) {
        highestTurnOrdinal += 1;
        cursor = derivedTurn(event.id, highestTurnOrdinal);
        advanceBeforeNextModelPhase = false;
      } else if (
        advanceBeforeNextModelPhase
        && (phase === "reasoning" || phase === "assistant" || phase === "tool-call")
      ) {
        cursor = nextStep(cursor);
        advanceBeforeNextModelPhase = false;
      }
      topology = derivedTopology(cursor, phase);
    }

    const ordinalTurnId = turnIdsByOrdinal.get(topology.turnOrdinal);
    if (ordinalTurnId !== undefined && ordinalTurnId !== topology.turnId) {
      addTopologyIssue(issue("turn-identity-conflict", [event.id]));
    } else {
      turnIdsByOrdinal.set(topology.turnOrdinal, topology.turnId);
    }

    let turn = turnsById.get(topology.turnId);
    if (turn === undefined) {
      turn = {
        turnId: topology.turnId,
        turnOrdinal: topology.turnOrdinal,
        eventIds: [],
        steps: [],
        stepsById: new Map(),
      };
      turns.push(turn);
      turnsById.set(topology.turnId, turn);
    } else if (turn.turnOrdinal !== topology.turnOrdinal) {
      addTopologyIssue(issue("turn-identity-conflict", [event.id]));
    }
    turn.eventIds.push(event.id);

    if (topology.stepId !== null && topology.stepOrdinal !== null) {
      const knownCoordinates = stepCoordinates.get(topology.stepId);
      if (
        knownCoordinates !== undefined
        && (knownCoordinates.turnId !== topology.turnId || knownCoordinates.stepOrdinal !== topology.stepOrdinal)
      ) {
        addTopologyIssue(issue("step-identity-conflict", [event.id]));
      } else {
        stepCoordinates.set(topology.stepId, {
          turnId: topology.turnId,
          stepOrdinal: topology.stepOrdinal,
        });
      }
      let step = turn.stepsById.get(topology.stepId);
      if (step === undefined) {
        step = { stepId: topology.stepId, stepOrdinal: topology.stepOrdinal, eventIds: [] };
        turn.steps.push(step);
        turn.stepsById.set(topology.stepId, step);
      } else if (step.stepOrdinal !== topology.stepOrdinal) {
        addTopologyIssue(issue("step-identity-conflict", [event.id]));
      }
      step.eventIds.push(event.id);
    }

    plannedEvents.push({
      eventId: event.id,
      sequence: event.sequence,
      kind: event.kind,
      topology,
    });

    if (phase === "tool-call") {
      toolCallCount += 1;
      const callId = toolCallId(event);
      if (callId === null) {
        missingToolCallIdCount += 1;
        issues.push(issue("missing-tool-call-id", [event.id]));
      } else if (seenToolCallIds.has(callId)) {
        issues.push(issue("duplicate-tool-call-id", [event.id], callId));
      } else {
        seenToolCallIds.add(callId);
        pendingToolCalls.set(callId, {
          eventId: event.id,
          turnId: topology.turnId,
          stepId: topology.stepId,
        });
        const key = pendingStepKey(topology.turnId, topology.stepId);
        pendingToolCallsByStep.set(key, (pendingToolCallsByStep.get(key) ?? 0) + 1);
      }
      continue;
    }

    if (phase === "tool-result") {
      const callId = toolCallId(event);
      if (callId === null) {
        orphanToolResultCount += 1;
        issues.push(issue("missing-tool-result-id", [event.id]));
        continue;
      }
      const call = pendingToolCalls.get(callId);
      if (call === undefined) {
        orphanToolResultCount += 1;
        issues.push(issue("orphan-tool-result", [event.id], callId));
        continue;
      }
      pendingToolCalls.delete(callId);
      matchedToolResultCount += 1;
      const callStepKey = pendingStepKey(call.turnId, call.stepId);
      const remainingForStep = (pendingToolCallsByStep.get(callStepKey) ?? 1) - 1;
      if (remainingForStep === 0) pendingToolCallsByStep.delete(callStepKey);
      else pendingToolCallsByStep.set(callStepKey, remainingForStep);
      if (topology.turnId !== call.turnId || topology.stepId !== call.stepId) {
        addTopologyIssue(issue("step-identity-conflict", [call.eventId, event.id], callId));
      } else if (remainingForStep === 0) {
        advanceBeforeNextModelPhase = true;
      }
    }
  }

  for (const [callId, call] of pendingToolCalls) {
    issues.push(issue("unclosed-tool-call", [call.eventId], callId));
  }

  const reasons = [...issues];
  const immutableTurns: ConversationTopologyTurnPlanV1[] = turns.map((turn) => ({
    turnId: turn.turnId,
    turnOrdinal: turn.turnOrdinal,
    eventIds: [...turn.eventIds],
    steps: turn.steps.map((step) => ({
      stepId: step.stepId,
      stepOrdinal: step.stepOrdinal,
      eventIds: [...step.eventIds],
    })),
  }));

  return {
    schemaVersion: 1,
    events: plannedEvents,
    turns: immutableTurns,
    continuationEligibility: {
      status: reasons.length === 0 ? "eligible" : "blocked",
      reasons,
    },
    diagnostics: {
      inputEventCount: inputEvents.length,
      conversationalEventCount: plannedEvents.length,
      unassignedEventCount: inputEvents.length - plannedEvents.length,
      turnCount: immutableTurns.length,
      stepCount: immutableTurns.reduce((total, turn) => total + turn.steps.length, 0),
      toolCallCount,
      matchedToolResultCount,
      orphanToolResultCount,
      unclosedToolCallCount: pendingToolCalls.size + missingToolCallIdCount,
      topologyConflictCount,
    },
  };
}
