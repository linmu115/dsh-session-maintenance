import { describe, expect, it } from "vitest";

import { UiSessionManager } from "../src/http/ui-session.js";

describe("UiSessionManager launch expiry", () => {
  it("fails closed after the short launch-code TTL", () => {
    let now = 1_000;
    const manager = new UiSessionManager(() => now, 50, 1_000);
    const launch = manager.issue("http://127.0.0.1:43123");
    const code = new URL(launch.url).searchParams.get("code")!;
    now += 51;
    expect(manager.claim(code)).toBeUndefined();
  });
});
