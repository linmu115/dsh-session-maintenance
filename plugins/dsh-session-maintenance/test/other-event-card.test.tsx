import { describe, expect, it } from "vitest";

import {
  maintenanceOtherConversationDefinition,
  maintenanceOtherEventData,
} from "../src/client/other-event-card.js";

describe("Maintenance other event card", () => {
  const event = {
    type: "maintenance/other",
    seq: 7,
    data: {
      canonicalContent: {
        schemaVersion: 1,
        type: "other",
        reason: "no-common-semantics",
        sourceKind: "codex/unsupported",
        label: "未映射记录",
        summary: "只供用户查阅",
        evidenceRef: "sha256:evidence",
      },
      presentation: "tool-card",
      modelExposure: "log-only",
    },
  } as const;

  it("matches only explicitly log-only Maintenance records", () => {
    expect(maintenanceOtherEventData(event)).toMatchObject({
      label: "未映射记录",
      summary: "只供用户查阅",
      sourceKind: "codex/unsupported",
      reason: "no-common-semantics",
    });
    expect(maintenanceOtherEventData({ ...event, data: { ...event.data, modelExposure: "model-visible" } })).toBeUndefined();
    expect(maintenanceOtherEventData({ ...event, type: "tool/result" })).toBeUndefined();
  });

  it("publishes a visible tool-card node without changing the event surface", () => {
    const match = maintenanceOtherConversationDefinition.match(event);
    expect(match).toEqual({ id: "maintenance-other:7", role: "start" });
    const state = maintenanceOtherConversationDefinition.start(
      { key: "key", id: "node" },
      { event, location: { kind: "session" } },
    );
    expect(maintenanceOtherConversationDefinition.buildViewNode({ key: "key", id: "node", state })).toMatchObject({
      kind: "dsh-session-maintenance-other",
      anchorSeq: 7,
      visibility: "visible",
      data: { label: "未映射记录" },
    });
  });
});
