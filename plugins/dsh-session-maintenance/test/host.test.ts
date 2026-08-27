import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/config.js";

describe("DSH host configuration boundary", () => {
  it("contains only connection and instance IDs, never a capability or filesystem root", () => {
    const config = normalizeConfig({ connectionId: "primary", dshInstanceId: "dsh-web", profileId: "web" });
    expect(config).toEqual({ connectionId: "primary", dshInstanceId: "dsh-web", profileId: "web" });
    expect(JSON.stringify(config)).not.toMatch(/token|capability|origin|path|root/iu);
  });

  it("rejects path-shaped trusted registration IDs", () => {
    expect(() => normalizeConfig({ connectionId: "D:/state/connection.json", dshInstanceId: "dsh-web", profileId: "web" })).toThrow("connectionId");
  });
});
