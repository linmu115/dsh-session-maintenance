import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionMaintenanceSettingsSection } from "../src/client/settings-actions.js";
import { openDashboard } from "../src/client/dashboard-entry.js";
import { RestrictedEngineProxy } from "../src/engine-proxy.js";

const feedback = vi.hoisted(() => [] as string[]);
// Exercise the actual rendered button handler and real proxy together, without
// requiring a browser or running effect-driven settings hydration.
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: () => undefined,
  useState: (initial: unknown) => [initial, (value: unknown) => { if (typeof value === "string") feedback.push(value); }],
}));
afterEach(() => { feedback.length = 0; vi.unstubAllGlobals(); });

function fixture() {
  const open = vi.fn();
  vi.stubGlobal("window", { open });
  const calls: string[] = [];
  const proxy = new RestrictedEngineProxy({ connectionId: "synthetic", dshInstanceId: "dsh-fixture", profileId: "web" },
    { current: async () => ({ origin: "http://127.0.0.1:43123", token: "s".repeat(43) }) },
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path.endsWith("/identity")) return new Response(JSON.stringify({ error: { code: "SESSION_NOT_MAPPED", message: "Session is not mapped in this active projection run" } }), { status: 404 });
      expect(path).toBe("/v1/ui/launch-code");
      expect(JSON.parse(String(init?.body))).toEqual({});
      return new Response(JSON.stringify({ launch: { url: "http://127.0.0.1:43123/launch?code=synthetic" } }));
    }, "run-current-synthetic");
  return { open, calls, actions: { invoke: proxy.invoke.bind(proxy) } };
}

function buttons(node: ReactNode): ReactElement<{ children?: ReactNode; onClick(): void }>[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode; onClick(): void }>(child)) return [];
    return child.type === "button" ? [child] : buttons(child.props.children);
  });
}

it.each([undefined, "new-unmapped-native", "previous-run-native"])("opens the full settings Dashboard with current session %s", async selected => {
  const f = fixture();
  const currentSessionId = vi.fn(() => selected);
  const tree = SessionMaintenanceSettingsSection({ actions: f.actions, currentSessionId });
  const button = buttons(tree).find(item => item.props.children === "打开完整看板")!;
  expect(button).toBeDefined();
  button.props.onClick();
  await vi.waitFor(() => expect(feedback.at(-1)).not.toBe("正在执行…"));
  expect(feedback.at(-1)).toBe("已打开会话维护看板");
  expect(f.open).toHaveBeenCalledWith("http://127.0.0.1:43123/launch?code=synthetic", "_blank", "noopener,noreferrer");
  expect(f.calls).toEqual(["/v1/ui/launch-code"]);
  expect(currentSessionId).not.toHaveBeenCalled();
});

it("opens a global navigation entry without requiring a session", async () => {
  const f = fixture();
  await openDashboard(f.actions);
  expect(f.calls).toEqual(["/v1/ui/launch-code"]);
  expect(f.open).toHaveBeenCalledOnce();
});

it("keeps session-targeted Dashboard navigation strict when the selected session is unmapped", async () => {
  const f = fixture();
  await expect(openDashboard(f.actions, undefined, "unmapped-native")).rejects.toThrow("Session is not mapped");
  expect(f.calls).toEqual(["/v1/projection-runs/run-current-synthetic/sessions/unmapped-native/identity"]);
  expect(f.open).not.toHaveBeenCalled();
});
