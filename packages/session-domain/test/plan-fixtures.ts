import type {
  AdapterContractRef,
  BindingSnapshot,
  NormalizedEvent,
} from "@linmu/dsh-session-contracts";

import type { CreateSyncPlanRequest, PlanningHead } from "../src/index.js";

export const adapterContracts: readonly AdapterContractRef[] = [
  {
    adapter: "fixture-read",
    platformVersion: "1.0.0",
    schemaFingerprint: "fixture-schema",
  },
];

export const event = (id: string, content: string): NormalizedEvent => ({
  id,
  parentId: null,
  sequence: Number(id.slice(1)),
  kind: "message",
  role: "user",
  content,
  attachments: [],
  source: {
    platform: "dsh",
    instanceId: "dsh-fixture",
    sessionId: "session-a",
    eventId: id,
    sequence: Number(id.slice(1)),
  },
  extensions: {},
});

function snapshot(
  bindingId: string,
  platform: "codex" | "dsh",
  versionId: string,
  value: string,
): BindingSnapshot {
  return {
    bindingId,
    key: { platform, instanceId: `${platform}-fixture`, sessionId: `${platform}-session` },
    versionId,
    fingerprints: [
      {
        platform,
        instanceId: `${platform}-fixture`,
        sessionId: `${platform}-session`,
        kind: "content",
        value,
      },
    ],
  };
}

export function planningHead(
  bindingId: string,
  platform: "codex" | "dsh",
  versionId: string,
  events: readonly NormalizedEvent[],
  title = "Session",
  archived = false,
): PlanningHead {
  return {
    snapshot: snapshot(bindingId, platform, versionId, `${versionId}-fingerprint`),
    events,
    metadata: { title, archived },
  };
}

export function appendOnlyPlanFixture(createdAt: string): CreateSyncPlanRequest {
  const baseEvents = [event("e0", "base")];
  return {
    createdAt,
    logicalSessionId: "logical-a",
    baseVersionId: "version-base",
    base: { events: baseEvents, metadata: { title: "Session", archived: false } },
    source: planningHead(
      "binding-source",
      "codex",
      "version-source",
      [...baseEvents, event("e1", "new")],
    ),
    target: {
      kind: "present",
      head: planningHead("binding-target", "dsh", "version-target", baseEvents),
    },
    adapterContracts,
  };
}
