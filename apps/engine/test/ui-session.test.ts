import { afterEach, describe, expect, it } from "vitest";

import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { createEngineFixture } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("Dashboard UI session boundary", () => {
  it("exchanges one-use launch codes for HttpOnly cookies and requires exact Origin plus CSRF", async () => {
    const fixture = await createEngineFixture("ui-session");
    cleanups.push(fixture.cleanupAll);
    const server = await fixture.startServer();
    const trusted = new MaintenanceClient({ origin: server.origin, token: server.token });

    const launch = await trusted.createDashboardLaunchCode("logical-session-fixture");
    expect(launch.url.startsWith(`${server.origin}/ui/claim?code=`)).toBe(true);
    const claim = await fetch(launch.url, { redirect: "manual" });
    expect(claim.status).toBe(303);
    expect(claim.headers.get("location")).toBe("/dashboard/");
    const setCookie = claim.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie.split(";", 1)[0]!;
    expect((await fetch(launch.url, { redirect: "manual" })).status).toBe(410);

    const malicious = await fetch(`${server.origin}/v1/ui/session`, {
      headers: { cookie, origin: "https://malicious.invalid" },
    });
    expect(malicious.status).toBe(403);
    const bootstrap = await fetch(`${server.origin}/v1/ui/session`, {
      headers: { cookie, "sec-fetch-site": "same-origin" },
    });
    expect(bootstrap.status).toBe(200);
    const session = await bootstrap.json() as { readonly session: { readonly csrfToken: string; readonly initialLogicalSessionId?: string } };
    expect(session.session.csrfToken.length).toBeGreaterThanOrEqual(32);
    expect(session.session.initialLogicalSessionId).toBe("logical-session-fixture");
    expect(JSON.stringify(session)).not.toContain(server.token);

    const crossSiteWithoutOrigin = await fetch(`${server.origin}/v1/ui/session`, {
      headers: { cookie, "sec-fetch-site": "cross-site" },
    });
    expect(crossSiteWithoutOrigin.status).toBe(403);

    expect((await fetch(`${server.origin}/v1/overview`, {
      headers: { cookie, origin: server.origin },
    })).status).toBe(403);
    expect((await fetch(`${server.origin}/v1/overview`, {
      headers: { cookie, origin: server.origin, "x-dsh-csrf": "wrong" },
    })).status).toBe(403);
    expect((await fetch(`${server.origin}/v1/overview`, {
      headers: { cookie, origin: server.origin, "x-dsh-csrf": session.session.csrfToken },
    })).status).toBe(200);

    const unknownLaunchField = await fetch(`${server.origin}/v1/ui/launch-code`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify({ redirect: "https://malicious.invalid" }),
    });
    expect(unknownLaunchField.status).toBe(400);
  });
});
