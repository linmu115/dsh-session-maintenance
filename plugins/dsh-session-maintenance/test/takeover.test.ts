import { expect, it, vi } from "vitest";
import { maintenanceStateRoot } from "../src/config.js";
import { InstanceLeasePublisher, startInstanceLease } from "../src/instance-lease.js";
import { TakeoverPoller, startTakeoverPolling } from "../src/takeover.js";

const identity = { instanceId: "i-one", profileId: "web", homeRoot: "C:\\home",
  runtimeUrl: "http://127.0.0.1:19876", pid: 42, processStartedAt: "2026-09-21T09:00:00.000Z" };
const connection = async () => ({ origin: "http://127.0.0.1:41000", token: "token-abc" });

it("resolves the state root through the same chain as the connection descriptor", () => {
  // 1. the installer's registered descriptor path owns the directory
  expect(maintenanceStateRoot("primary", { DSH_SESSION_MAINTENANCE_CONNECTION_PRIMARY: "D:\\state\\connection.json" }))
    .toBe("D:\\state");
  // 2. the explicit state root
  expect(maintenanceStateRoot("primary", { DSH_SESSION_MAINTENANCE_STATE_ROOT: " E:\\mnt " })).toBe("E:\\mnt");
  // 3. the per-user conventional location
  expect(maintenanceStateRoot("primary", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }))
    .toBe("C:\\Users\\u\\AppData\\Local\\DSH-Session-Maintenance");
  // A non-primary connection has no conventional location, and no answer is not an error.
  expect(maintenanceStateRoot("secondary", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" })).toBeUndefined();
  expect(maintenanceStateRoot("primary", {})).toBeUndefined();
});

it("writes a handshake while the Engine is absent", async () => {
  const written: unknown[] = [];
  // Only DSH_HOME is needed: the Engine resolves the web port from the instance's
  // own configuration, so the instance never has to be told its own port.
  const publisher = await startInstanceLease({ instanceId: "i-one", profileId: "web", stateRoot: "D:\\state",
    environment: { DSH_HOME: "C:\\home" }, startedAt: async () => identity.processStartedAt,
    write: async (_root, lease) => { written.push(lease); }, clock: () => "2026-09-21T10:00:00.000Z" });
  expect(written).toEqual([{ schemaVersion: 1, instanceId: "i-one", profileId: "web", pid: process.pid,
    processStartedAt: identity.processStartedAt, homeRoot: "C:\\home", runtimeUrl: null,
    state: "idle", attachedRunId: null, updatedAt: "2026-09-21T10:00:00.000Z" }]);
  expect(publisher?.current()).toEqual({ state: "idle", attachedRunId: null });
  // When the host does state an endpoint it is used verbatim, as an override only.
  const overridden: Array<{ runtimeUrl: string | null }> = [];
  await startInstanceLease({ instanceId: "i-one", profileId: "web", stateRoot: "D:\\state",
    environment: { DSH_HOME: "C:\\home", DSH_SESSION_MAINTENANCE_RUNTIME_URL: "http://127.0.0.1:19876" },
    startedAt: async () => identity.processStartedAt, write: async (_root, lease) => { overridden.push(lease); } });
  expect(overridden[0]!.runtimeUrl).toBe("http://127.0.0.1:19876");
});

it("states no handshake when the instance cannot say who it is or where to write", async () => {
  const write = vi.fn();
  // No state root: this instance was never registered with an installer.
  expect(await startInstanceLease({ instanceId: "i-one", profileId: "web", stateRoot: undefined, write })).toBeNull();
  // No DSH Home: the folder connection could never be tied to this process.
  expect(await startInstanceLease({ instanceId: "i-one", profileId: "web", stateRoot: "D:\\state",
    environment: {}, startedAt: async () => identity.processStartedAt, write })).toBeNull();
  // A non-loopback endpoint override is ignored rather than published; the lease
  // is still written, because the Engine resolves the port from the configuration.
  const nonLoopback: Array<{ runtimeUrl: string | null }> = [];
  const publisher = await startInstanceLease({ instanceId: "i-one", profileId: "web", stateRoot: "D:\\state",
    environment: { DSH_HOME: "C:\\home", DSH_SESSION_MAINTENANCE_RUNTIME_URL: "http://10.0.0.5:1" },
    startedAt: async () => identity.processStartedAt, write: async (_root, lease) => { nonLoopback.push(lease); } });
  expect(nonLoopback).toHaveLength(1);
  expect(nonLoopback[0]!.runtimeUrl).toBeNull();
  expect(publisher).not.toBeNull();
  // No OS process identity: the Engine could never confirm this process.
  expect(await startInstanceLease({ instanceId: "i-one", profileId: "web", stateRoot: "D:\\state",
    environment: { DSH_HOME: "C:\\home" }, startedAt: async () => null, write })).toBeNull();
  expect(write).not.toHaveBeenCalled();
});

it("asks the user about a requested synchronisation and reports the answer", async () => {
  const request = { schemaVersion: 1, requestId: "sync-one", instanceId: "i-one", profileId: "web",
    summary: "覆盖 3 个会话", requestedAt: "2026-09-21T10:00:00.000Z" };
  const decisions: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (String(url).includes("/takeovers?")) return new Response(JSON.stringify({ takeovers: [] }), { status: 200 });
    if (String(url).includes("/sync-requests?") && (init.method ?? "GET") === "GET")
      return new Response(JSON.stringify({ requests: [request] }), { status: 200 });
    decisions.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const asked: string[] = [];
  const approving = new TakeoverPoller({ identity, connection, intervalMs: 10, publisher: { async publish() {} },
    attach: async () => undefined, fetchImpl, confirm: async asked_request => { asked.push(asked_request.requestId); return true; } });
  await approving.tick();
  // The prompt carries what the Engine wanted, so the user can judge it.
  expect(asked).toEqual(["sync-one"]);
  expect(decisions).toEqual([expect.objectContaining({ requestId: "sync-one", decision: "approved", instanceId: "i-one", profileId: "web" })]);
  // An answered request is never asked again.
  await approving.tick();
  expect(asked).toEqual(["sync-one"]);
  await approving.stop();

  // Refusing is reported, and a missing confirmation entry can never become consent.
  for (const [confirm, expected] of [[undefined, "declined"], [async () => false, "declined"]] as const) {
    const seen: Array<Record<string, unknown>> = [];
    const poller = new TakeoverPoller({ identity, connection, intervalMs: 10, publisher: { async publish() {} },
      attach: async () => undefined, ...(confirm === undefined ? {} : { confirm }), report: () => undefined,
      fetchImpl: (async (url: string, init: RequestInit) => {
        if (String(url).includes("/takeovers?")) return new Response(JSON.stringify({ takeovers: [] }), { status: 200 });
        if (String(url).includes("/sync-requests?") && (init.method ?? "GET") === "GET")
          return new Response(JSON.stringify({ requests: [request] }), { status: 200 });
        seen.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch });
    await poller.tick();
    expect(seen[0]).toMatchObject({ decision: expected });
    await poller.stop();
  }

  // Nobody answering in time is a decline, not a silent approval.
  const timedOut: Array<Record<string, unknown>> = [];
  const waiting = new TakeoverPoller({ identity, connection, intervalMs: 10, confirmTimeoutMs: 20,
    publisher: { async publish() {} }, attach: async () => undefined, confirm: () => new Promise<boolean>(() => undefined),
    fetchImpl: (async (url: string, init: RequestInit) => {
      if (String(url).includes("/takeovers?")) return new Response(JSON.stringify({ takeovers: [] }), { status: 200 });
      if (String(url).includes("/sync-requests?") && (init.method ?? "GET") === "GET")
        return new Response(JSON.stringify({ requests: [request] }), { status: 200 });
      timedOut.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch });
  await waiting.tick();
  expect(timedOut[0]).toMatchObject({ decision: "expired", detail: expect.stringContaining("未在期限内") });
  await waiting.stop();

  // A confirmation that throws is also a decline, never an implicit yes.
  const thrown: Array<Record<string, unknown>> = [];
  const broken = new TakeoverPoller({ identity, connection, intervalMs: 10, publisher: { async publish() {} },
    attach: async () => undefined, confirm: async () => { throw new Error("no interactive surface"); }, report: () => undefined,
    fetchImpl: (async (url: string, init: RequestInit) => {
      if (String(url).includes("/takeovers?")) return new Response(JSON.stringify({ takeovers: [] }), { status: 200 });
      if (String(url).includes("/sync-requests?") && (init.method ?? "GET") === "GET")
        return new Response(JSON.stringify({ requests: [request] }), { status: 200 });
      thrown.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch });
  await broken.tick();
  expect(thrown[0]).toMatchObject({ decision: "declined" });
  await broken.stop();
});

/** One fetch stub covering the poll list and the claim of a ticket. */
function engine(handoffs: Record<string, unknown> | undefined, list: unknown[] = [{ ticketId: "ticket-one", runId: "run-one",
  createdAt: "2026-09-21T10:00:00.000Z", claimPath: "/v1/integrations/takeover/ticket-one/claim" }], failure?: Error) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push(String(url));
    if (failure !== undefined) throw failure;
    if (String(url).includes("/takeovers?")) return new Response(JSON.stringify({ takeovers: list }), { status: 200 });
    return new Response(JSON.stringify({ handoff: handoffs }), { status: handoffs === undefined ? 409 : 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

it("claims a prepared run once the Engine appears and stops advertising itself as free", async () => {
  const remote = engine({ schemaVersion: 1, ticketId: "ticket-one", instanceId: "i-one", profileId: "web", runId: "run-one",
    runtimeClientId: "plugin-one", ownerClientId: "engine-one", temporaryPersistenceRootId: "projection:run-one",
    maintenanceEndpoint: "http://127.0.0.1:19876", dshVersion: "0.1.5-rc.2", adapterId: "dsh-0.1.5",
    nativeMode: "persistent-native-v1", createdAt: "2026-09-21T10:00:00.000Z", claimedAt: null });
  const attached: unknown[] = [];
  const published: Array<{ state: string; runId: string | null }> = [];
  const poller = new TakeoverPoller({ identity, connection, intervalMs: 10,
    publisher: { async publish(state, runId) { published.push({ state, runId }); } },
    attach: async handoff => { attached.push(handoff.runId); }, fetchImpl: remote.fetchImpl });
  await poller.tick();
  expect(attached).toEqual(["run-one"]);
  expect(published).toEqual([{ state: "attached", runId: "run-one" }]);
  expect(poller.claimedTickets()).toEqual(["ticket-one"]);
  // The Engine omits claimed tickets, and a repeat of the same one is never attached twice.
  await poller.tick();
  expect(attached).toEqual(["run-one"]);
});

it("keeps the instance running when the Engine is absent, and retries until it appears", async () => {
  const failures: string[] = [];
  let reachable = false;
  const fetchImpl = (async (url: string) => {
    if (!reachable) throw new Error("ECONNREFUSED");
    if (String(url).includes("/takeovers?")) return new Response(JSON.stringify({ takeovers: [] }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const poller = new TakeoverPoller({ identity, connection, intervalMs: 10, publisher: { async publish() {} },
    attach: async () => undefined, fetchImpl, report: message => failures.push(message) });
  await poller.tick();
  await poller.tick();
  // A missing Engine is reported once, not once per tick, and never thrown.
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("ECONNREFUSED");
  reachable = true;
  await poller.tick();
  expect(failures).toHaveLength(1);
  await poller.stop();
});

it("survives a refused ticket and a rejected claim instead of blocking the instance", async () => {
  const refused = engine(undefined);
  const attached: unknown[] = [];
  const reported: string[] = [];
  const poller = new TakeoverPoller({ identity, connection, intervalMs: 10, publisher: { async publish() {} },
    attach: async handoff => { attached.push(handoff); }, fetchImpl: refused.fetchImpl, report: message => reported.push(message) });
  await poller.tick();
  // A refused ticket will never become claimable, so it is remembered, not retried forever.
  expect(poller.claimedTickets()).toEqual(["ticket-one"]);
  expect(attached).toEqual([]);
  expect(reported.join(" ")).toContain("已被拒绝或已被领取");
  await poller.tick();
  expect(refused.calls.filter(url => url.includes("/claim"))).toHaveLength(1);

  // A malformed or unreadable list is a failure like any other: no claim, no crash.
  const garbled = new TakeoverPoller({ identity, connection, intervalMs: 10, publisher: { async publish() {} },
    attach: async () => undefined, report: () => undefined,
    fetchImpl: (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch });
  await expect(garbled.tick()).resolves.toBeUndefined();
  await garbled.stop();
});

it("starts polling only when the instance can locate the Engine's state root", async () => {
  const attach = vi.fn();
  const options = { identity, connection, publisher: { async publish() {} }, attach, fetchImpl: engine({}).fetchImpl };
  // No registration and no LOCALAPPDATA: the instance simply runs without a takeover channel.
  expect(startTakeoverPolling({ ...options, environment: {} })).toBeUndefined();
  const started = startTakeoverPolling({ ...options, environment: { DSH_SESSION_MAINTENANCE_STATE_ROOT: "D:\\state" } });
  expect(started).toBeInstanceOf(TakeoverPoller);
  await started?.stop();
  // The lease publisher is what the poller uses to mark the instance attached.
  const publisher = new InstanceLeasePublisher(identity, async () => undefined);
  expect(publisher.identity).toMatchObject({ instanceId: "i-one", profileId: "web" });
});
