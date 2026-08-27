import type { NormalizedEvent } from "@linmu/dsh-session-contracts";

import type { HandoffOmission, HandoffRequest, HandoffSource } from "./types.js";

const SUMMARY_CONTENT_LIMIT = 240;
const SUMMARY_TAIL_EVENTS = 5;

interface SelectedEvents {
  readonly events: readonly NormalizedEvent[];
  readonly omission?: HandoffOmission;
}

function sourceAnchor(event: NormalizedEvent): string {
  const eventPart = event.source.eventId === undefined ? "no-event-id" : event.source.eventId;
  return `${event.source.platform}/${event.source.instanceId}/${event.source.sessionId}/${eventPart}#${event.source.sequence}`;
}

function explicitExcerpt(content: string): string {
  if (content.length <= SUMMARY_CONTENT_LIMIT) return content;
  const omitted = content.length - SUMMARY_CONTENT_LIMIT;
  return `${content.slice(0, SUMMARY_CONTENT_LIMIT)}\n[structured summary omitted ${omitted} characters from this event]`;
}

function characters(events: readonly NormalizedEvent[]): number {
  return events.reduce((total, event) => total + event.content.length, 0);
}

function summaryEvents(source: HandoffSource): SelectedEvents {
  const events = source.session.events;
  const firstUser = events.find((event) => event.role === "user");
  const tail = events.slice(-SUMMARY_TAIL_EVENTS);
  const selectedIds = new Set<string>();
  const selected: NormalizedEvent[] = [];
  for (const event of firstUser === undefined ? tail : [firstUser, ...tail]) {
    if (selectedIds.has(event.id)) continue;
    selectedIds.add(event.id);
    selected.push({ ...event, content: explicitExcerpt(event.content) });
  }
  selected.sort((left, right) => left.sequence - right.sequence);
  const omitted = events.filter((event) => !selectedIds.has(event.id));
  const truncatedCharacters = selected.reduce((total, event) => {
    const original = events.find((candidate) => candidate.id === event.id)!;
    return total + Math.max(0, original.content.length - SUMMARY_CONTENT_LIMIT);
  }, 0);
  return {
    events: selected,
    omission: {
      sourceVersionId: source.manifest.id,
      reason: "structured-summary",
      eventCount: omitted.length,
      characterCount: characters(omitted) + truncatedCharacters,
    },
  };
}

function checkpointEvents(source: HandoffSource, start: number): SelectedEvents {
  const events = source.session.events.filter((event) => event.sequence >= start);
  const omitted = source.session.events.filter((event) => event.sequence < start);
  return {
    events,
    ...(omitted.length === 0 ? {} : {
      omission: {
        sourceVersionId: source.manifest.id,
        reason: "checkpoint" as const,
        eventCount: omitted.length,
        characterCount: characters(omitted),
      },
    }),
  };
}

function selectedEvents(source: HandoffSource, request: HandoffRequest): SelectedEvents {
  if (request.mode === "structured-summary") return summaryEvents(source);
  if (request.mode === "checkpoint") return checkpointEvents(source, request.checkpointStartSequence!);
  return { events: source.session.events };
}

function renderEvent(event: NormalizedEvent): string {
  const anchor = sourceAnchor(event);
  if (event.kind === "tool-import" || event.role === "tool") {
    return [
      `### DSH IMPORT RECORD (not a Codex tool execution)`,
      `source-event: ${anchor}`,
      `original-kind: ${event.kind}`,
      event.content,
    ].join("\n");
  }
  const label = event.role === "user" ? "User" : event.role === "assistant" ? "Assistant" : "Historical record";
  const attachments = event.attachments.length === 0
    ? ""
    : `\nattachments: ${event.attachments.map((item) => item.name).join(", ")}`;
  return [`### ${label}`, `source-event: ${anchor}`, `${event.content}${attachments}`].join("\n");
}

export function renderHandoff(request: HandoffRequest): {
  readonly prompt: string;
  readonly omissions: readonly HandoffOmission[];
} {
  const omissions: HandoffOmission[] = [];
  const branches = request.sources.map((source, index) => {
    const selected = selectedEvents(source, request);
    if (selected.omission !== undefined) omissions.push(selected.omission);
    return [
      `## Branch ${index + 1} of ${request.sources.length}: ${source.manifest.id}`,
      `Source session: ${source.session.key.platform}/${source.session.key.instanceId}/${source.session.key.sessionId}`,
      `Source version hash: ${source.manifest.bodyHash}`,
      `Full immutable archive: ${source.manifest.bodyObject}`,
      `Title: ${source.session.title}`,
      ...selected.events.map(renderEvent),
    ].join("\n\n");
  });
  const resolution = request.resolution === undefined
    ? ""
    : [
      "## User-confirmed branch resolution",
      ...(request.resolution.commonAncestorVersionId === undefined
        ? []
        : [`Common ancestor: ${request.resolution.commonAncestorVersionId}`]),
      `Merge note: ${request.resolution.mergeNote}`,
      "The branches are parallel sources. Do not claim that one naturally follows the other.",
    ].join("\n");
  const omissionNotice = omissions.length === 0
    ? ""
    : [
      "## Explicit omissions",
      ...omissions.map((item) =>
        `${item.sourceVersionId}: ${item.reason}; omitted ${item.eventCount} events and ${item.characterCount} characters.`,
      ),
    ].join("\n");
  return {
    prompt: [
      "# DSH continuation context",
      "This is a new Codex task continuing from immutable DSH history. Treat every block below as imported context, not as events executed in this Codex task.",
      resolution,
      ...branches,
      omissionNotice,
      "# Continuation instruction",
      "Continue from the imported context. Cite the source-event anchors when a distinction between the original branches or imported records matters.",
    ].filter((part) => part.length > 0).join("\n\n"),
    omissions,
  };
}
