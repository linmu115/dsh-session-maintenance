import { describe, expect, it, vi } from "vitest";

import { dashboardLaunchCommand } from "../src/dashboard-launcher.js";
import { MANAGER_ACTIONS, PACKAGE_NAME, registerManagerActions } from "../src/manager-actions.js";

describe("Manager dashboard panel actions", () => {
  it("registers every declarative action against the existing Engine proxy", async () => {
    const handlers = new Map<string, () => Promise<{ readonly message: string }>>();
    const deferred: Array<() => void | Promise<void>> = [];
    const proxy = { invoke: vi.fn(async (request: { operation: string }) => (
      request.operation === "dashboard"
        ? { ok: true as const, message: "ready", url: "http://127.0.0.1:41781/launch?code=fixture" }
        : { ok: true as const, message: request.operation }
    )) };
    const openDashboard = vi.fn(async () => undefined);
    const ctx = {
      resourceManagementActions: {
        register(packageName: string, actionId: string, handler: () => Promise<{ readonly message: string }>) {
          expect(packageName).toBe(PACKAGE_NAME);
          handlers.set(actionId, handler);
          return () => handlers.delete(actionId);
        },
        deferUntilResponse(task: () => void | Promise<void>) { deferred.push(task); },
      },
      effect(callback: () => void | (() => void)) { callback(); },
    };

    registerManagerActions(ctx, proxy, openDashboard);
    expect([...handlers.keys()].sort()).toEqual(Object.values(MANAGER_ACTIONS).sort());
    await handlers.get(MANAGER_ACTIONS.checkEngine)!();
    await handlers.get(MANAGER_ACTIONS.scanSessions)!();
    await handlers.get(MANAGER_ACTIONS.openDashboard)!();
    expect(proxy.invoke).toHaveBeenCalledWith({ operation: "status" });
    expect(proxy.invoke).toHaveBeenCalledWith({ operation: "scan-current" });
    expect(openDashboard).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    await deferred[0]!();
    expect(openDashboard).toHaveBeenCalledWith("http://127.0.0.1:41781/launch?code=fixture");
  });

  it("only launches loopback HTTP dashboard URLs without a shell", () => {
    expect(dashboardLaunchCommand("http://127.0.0.1:41781/launch?code=x", "win32")).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:41781/launch?code=x"],
    });
    expect(() => dashboardLaunchCommand("https://example.com/steal", "win32")).toThrow("本机 HTTP 地址");
  });
});
