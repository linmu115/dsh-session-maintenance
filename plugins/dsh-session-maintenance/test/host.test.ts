import { describe, expect, it } from "vitest";

import { connectionDescriptorPath, normalizeConfig } from "../src/config.js";

describe("DSH host configuration boundary", () => {
  it("contains only connection and instance IDs, never a capability or filesystem root", () => {
    const config = normalizeConfig({ connectionId: "primary", dshInstanceId: "dsh-web", profileId: "web" });
    expect(config).toEqual({ connectionId: "primary", dshInstanceId: "dsh-web", profileId: "web" });
    expect(JSON.stringify(config)).not.toMatch(/token|capability|origin|path|root/iu);
  });

  it("rejects path-shaped trusted registration IDs", () => {
    expect(() => normalizeConfig({ connectionId: "D:/state/connection.json", dshInstanceId: "dsh-web", profileId: "web" })).toThrow("connectionId");
  });

  it("resolves primary from the installer-owned per-user location when a launcher filters custom variables", () => {
    expect(connectionDescriptorPath("primary", { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }))
      .toBe("C:\\Users\\test\\AppData\\Local\\DSH-Session-Maintenance\\connection.json");
  });

  it("prefers an explicit trusted registration and does not guess non-primary registrations", () => {
    expect(connectionDescriptorPath("primary", {
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      DSH_SESSION_MAINTENANCE_CONNECTION_PRIMARY: "D:\\registered\\connection.json",
    })).toBe("D:\\registered\\connection.json");
    expect(connectionDescriptorPath("secondary", { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" })).toBeUndefined();
  });
});
