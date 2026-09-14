import { describe, expect, it } from "vitest";
import { MaintenanceExtensionBridge } from "../src/extension-data.js";

describe("extension list scope", () => {
  it("preserves the active default and forwards deleted visibility and pagination in the authenticated host URL", async () => {
    const urls: URL[] = [];
    const bridge = new MaintenanceExtensionBridge({ current: async () => ({ origin: "http://127.0.0.1:1234", token: "fixture" }) },
      { instanceId: "copy", profileId: "web" }, [{ namespace: "thoughtdag", pluginVersion: "0.4.14-rc2.1", writerId: "dsh-thoughtdag" }],
      (async (url: string, init: RequestInit) => {
        urls.push(new URL(url)); expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture");
        return new Response(JSON.stringify({ items: [], nextCursor: null }));
      }) as typeof fetch);
    await bridge.list("thoughtdag");
    await bridge.list("thoughtdag", "after-object", "deleted");
    await bridge.list("thoughtdag", undefined, "all");
    expect(urls.map(url => url.searchParams.get("deleted"))).toEqual(["active", "deleted", "all"]);
    expect(urls[1]!.searchParams.get("after")).toBe("after-object");
    for (const url of urls) {
      expect(url.pathname).toBe("/v1/extensions/objects");
      expect(url.searchParams.get("instanceId")).toBe("copy");
      expect(url.searchParams.get("profileId")).toBe("web");
      expect(url.searchParams.get("namespace")).toBe("thoughtdag");
    }
  });
});
