import { describe, expect, it } from "vitest";

import {
  MaintenanceOtherNodeView,
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

  it("keeps unknown events out of the chat timeline without changing stored diagnostics", () => {
    const match = maintenanceOtherConversationDefinition.match(event);
    expect(match).toEqual({ id: "maintenance-other:7", role: "start" });
    const state = maintenanceOtherConversationDefinition.start(
      { key: "key", id: "node" },
      { event, location: { kind: "session" } },
    );
    expect(maintenanceOtherConversationDefinition.buildViewNode({ key: "key", id: "node", state })).toBeNull();

  });

  it("decodes a grouped record and keeps its details closed by default", () => {
    const grouped = {
      ...event,
      data: {
        ...event.data,
        canonicalContent: {
          ...event.data.canonicalContent,
          sourceKind: "maintenance/grouped-other",
          label: "未映射记录（2 条）",
          evidenceRef: null,
        },
        collapsed: true,
        grouping: {
          schemaVersion: 1,
          count: 2,
          items: [{
            sourceKind: "codex/a",
            reason: "unsupported-source-event",
            label: "A",
            summary: "A summary",
            evidenceRef: "evidence:a",
          }, {
            sourceKind: "codex/b",
            reason: "unsupported-source-event",
            label: "B",
            summary: "B summary",
            evidenceRef: "evidence:b",
          }],
        },
      },
    } as const;
    const data = maintenanceOtherEventData(grouped);
    expect(data).toMatchObject({ count: 2, label: "未映射记录（2 条）" });
    expect(data?.items.map((item) => item.sourceKind)).toEqual(["codex/a", "codex/b"]);

    expect(MaintenanceOtherNodeView({ node: { data } })).toBeNull();

  });
});
