import { describe, expect, it } from "vitest";

import { PANEL_FIELDS } from "../src/client/settings-actions.js";

describe("lightweight parameter panel", () => {
  it("contains registered IDs and policies but no filesystem roots or capability", () => {
    expect(PANEL_FIELDS).toContain("codexInstanceId");
    expect(PANEL_FIELDS).toContain("dshInstanceId");
    expect(PANEL_FIELDS).toContain("workspaceMappingId");
    expect(PANEL_FIELDS).not.toContain("root" as never);
    expect(JSON.stringify(PANEL_FIELDS)).not.toMatch(/token|capability|path|home/iu);
  });
});
