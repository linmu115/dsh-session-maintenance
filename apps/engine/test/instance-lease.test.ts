import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { instanceLeaseSchema, maintenanceInstanceIdFor } from "@linmu/dsh-session-contracts";
import {
  INSTANCE_LEASE_DIRECTORY, challengeInstanceLiveness, inspectInstanceLease, instanceLeasePath, listInstanceLeases,
  removeInstanceLease, writeInstanceLease,
} from "../src/instance-lease.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function stateRoot() { const root = await mkdtemp(join(tmpdir(), "dsh-instance-lease-")); roots.push(root); return root; }

const at = "2026-09-21T10:00:00.000Z";
const processStartedAt = "2026-09-21T09:59:00.000Z";
const homeRoot = "C:\\合成\\my-dsh-home";
const lease = (over: Record<string, unknown> = {}) => instanceLeaseSchema.parse({ schemaVersion: 1, instanceId: "i-one", profileId: "web",
  pid: 4242, processStartedAt, homeRoot, runtimeUrl: "http://127.0.0.1:19876", state: "idle", attachedRunId: null, updatedAt: at, ...over });
/** OS evidence: the process named by the lease is alive unless the test says otherwise. */
const alive = (startedAt = processStartedAt) => vi.fn(async () => ({ bootedAt: at, process: { pid: 4242, startedAt, bootedAt: at } }));
const gone = () => vi.fn(async () => ({ bootedAt: at, process: null }));

it("writes, lists and removes a lease under the shared state-root directory", async () => {
  const root = await stateRoot();
  const path = await writeInstanceLease(root, lease());
  expect(path).toBe(join(root, INSTANCE_LEASE_DIRECTORY, `${maintenanceInstanceIdFor("i-one", "web")}.json`));
  // The file is the shape both sides agreed on, and nothing more.
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ schemaVersion: 1, instanceId: "i-one", profileId: "web", state: "idle" });
  await writeInstanceLease(root, lease({ instanceId: "i-two" }));
  expect((await listInstanceLeases(root)).map(item => item.instanceId).sort()).toEqual(["i-one", "i-two"]);
  // An unreadable or foreign file is skipped rather than failing the whole listing.
  await writeFile(join(root, INSTANCE_LEASE_DIRECTORY, "broken.json"), "{ not json");
  expect(await listInstanceLeases(root)).toHaveLength(2);
  await removeInstanceLease(root, "i-one", "web");
  expect((await listInstanceLeases(root)).map(item => item.instanceId)).toEqual(["i-two"]);
  // Removing what is not there is a normal outcome, not an error.
  await expect(removeInstanceLease(root, "i-one", "web")).resolves.toBeUndefined();
  expect(await listInstanceLeases(join(root, "no-such-root"))).toEqual([]);
});

it("reports a running instance only when the OS confirms the exact process", async () => {
  const root = await stateRoot();
  await writeInstanceLease(root, lease());
  const running = await inspectInstanceLease(root, { instanceId: "i-one", profileId: "web", processEvidence: alive() });
  expect(running).toMatchObject({ decision: "running", state: "idle", runtimeUrl: "http://127.0.0.1:19876",
    runtimeUrlSource: "instance",
    process: { pid: 4242, startedAt: processStartedAt }, homeRoot });
  expect(running.reason).toContain("可以接管");
});

it("reads the web port from the instance's own configuration when the instance does not state one", async () => {
  const root = await stateRoot();
  const profileRoot = join(root, "profiles", "web");
  await mkdir(profileRoot, { recursive: true });
  // The port lives where the host and the user put it, so nothing has to be asked of the operator.
  await writeFile(join(profileRoot, "cordis.patch.yml"),
    "- id: webserver\n  name: '@deepseek-ai/dsh-webserver'\n  config:\n    host: 127.0.0.1\n    port: 24999\n");
  await writeInstanceLease(root, lease({ runtimeUrl: null }));
  const configured = await inspectInstanceLease(root, { instanceId: "i-one", profileId: "web", profileRoot, processEvidence: alive() });
  expect(configured).toMatchObject({ decision: "running", runtimeUrl: "http://127.0.0.1:24999", runtimeUrlSource: "configuration" });
  // An endpoint the instance states itself wins: that is the process doing the listening.
  await writeInstanceLease(root, lease({ runtimeUrl: "http://127.0.0.1:19876" }));
  expect(await inspectInstanceLease(root, { instanceId: "i-one", profileId: "web", profileRoot, processEvidence: alive() }))
    .toMatchObject({ runtimeUrl: "http://127.0.0.1:19876", runtimeUrlSource: "instance" });
  // No port anywhere is reported as such, rather than worked around by asking for a variable.
  await rm(join(profileRoot, "cordis.patch.yml"));
  await writeInstanceLease(root, lease({ runtimeUrl: null }));
  const unresolved = await inspectInstanceLease(root, { instanceId: "i-one", profileId: "web", profileRoot, processEvidence: alive() });
  expect(unresolved).toMatchObject({ runtimeUrl: null, runtimeUrlSource: "none" });
  expect(unresolved.reason).toContain("拿不到它的 Web 端口");
  // A lease that cannot be trusted never supplies the endpoint; only the configuration can.
  await writeFile(join(profileRoot, "cordis.patch.yml"), "- id: webserver\n  config:\n    port: 24999\n");
  await writeFile(instanceLeasePath(root, "i-one", "web"), JSON.stringify({ ...lease(), instanceId: "i-other" }));
  const stale = await inspectInstanceLease(root, { instanceId: "i-one", profileId: "web", profileRoot, processEvidence: alive() });
  expect(stale).toMatchObject({ decision: "stale", runtimeUrl: "http://127.0.0.1:24999", runtimeUrlSource: "configuration" });
});

it("refuses a lease whose process is gone or whose identity was reused", async () => {
  const root = await stateRoot();
  await writeInstanceLease(root, lease());
  expect(await inspectInstanceLease(root, { instanceId: "i-one", profileId: "web", processEvidence: gone() }))
    .toMatchObject({ decision: "not-running", process: null });
  // Same PID, different start time: the operating system reused the number.
  const reused = await inspectInstanceLease(root, { instanceId: "i-one", profileId: "web", processEvidence: alive("2026-09-21T09:58:00.000Z") });
  expect(reused).toMatchObject({ decision: "not-running", process: null });
  // No OS evidence at all is a refusal to take over, never an optimistic guess.
  const unverifiable = await inspectInstanceLease(root, { instanceId: "i-one", profileId: "web",
    processEvidence: async () => { throw new Error("synthetic OS failure"); } });
  expect(unverifiable).toMatchObject({ decision: "not-running", process: null });
  expect(unverifiable.reason).toContain("无法核实");
});

it("separates an absent lease from a stale one and never acts on either", async () => {
  const root = await stateRoot();
  expect(await inspectInstanceLease(root, { instanceId: "i-one", profileId: "web", expectedHomeRoot: homeRoot, processEvidence: alive() }))
    .toMatchObject({ decision: "absent", state: null, runtimeUrl: null, homeRoot });
  await writeInstanceLease(root, lease());
  // A lease for another Home must not be used to take over the selected folder.
  expect(await inspectInstanceLease(root, { instanceId: "i-one", profileId: "web",
    expectedHomeRoot: "C:\\合成\\another-home", processEvidence: alive() })).toMatchObject({ decision: "stale" });
  // A lease naming a different instance cannot be presented as this one.
  await writeInstanceLease(root, lease({ instanceId: "i-other" }));
  await writeFile(instanceLeasePath(root, "i-one", "web"), JSON.stringify({ ...lease(), instanceId: "i-other" }));
  expect(await inspectInstanceLease(root, { instanceId: "i-one", profileId: "web", processEvidence: alive() }))
    .toMatchObject({ decision: "stale" });
  // A malformed file is stale, not absent: something wrote a handshake and it cannot be trusted.
  await writeFile(instanceLeasePath(root, "i-one", "web"), JSON.stringify({ schemaVersion: 1, instanceId: "i-one" }));
  const malformed = await inspectInstanceLease(root, { instanceId: "i-one", profileId: "web", processEvidence: alive() });
  expect(malformed.decision).toBe("stale");
  expect(malformed.reason).toContain("无法识别");
});

it("reports an already attached instance without pretending it is free", async () => {
  const root = await stateRoot();
  await writeInstanceLease(root, lease({ state: "attached", attachedRunId: "run-existing" }));
  const inspection = await inspectInstanceLease(root, { instanceId: "i-one", profileId: "web", processEvidence: alive() });
  expect(inspection).toMatchObject({ decision: "running", state: "attached", attachedRunId: "run-existing" });
  expect(inspection.reason).toContain("恢复该运行");
  await writeInstanceLease(root, lease({ state: "stopping" }));
  const stopping = await inspectInstanceLease(root, { instanceId: "i-one", profileId: "web", processEvidence: gone() });
  expect(stopping.reason).toContain("正在退出");
});

it("accepts a liveness answer only when the instance confirms the same identity, Home and process", async () => {
  const answer = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, responder: "dsh-session-maintenance", instanceId: "i-one",
    profileId: "web", matched: true, pid: 4242, homeRoot, state: "idle", attachedRunId: null, ...over });
  const ask = (body: unknown, status = 200) => challengeInstanceLiveness({ runtimeUrl: "http://127.0.0.1:19876", instanceId: "i-one",
    profileId: "web", pid: 4242, homeRoot, fetchImpl: (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch });

  const accepted = await ask(answer());
  expect(accepted).toMatchObject({ answered: true });
  // Each refusal is its own reason, and none of them is repaired into a takeover.
  for (const [body, expected] of [
    [answer({ matched: false }), "否认"],
    [answer({ instanceId: "i-other" }), "实例标识"],
    [answer({ profileId: "other" }), "实例标识"],
    [answer({ homeRoot: "C:\\合成\\again" }), "DSH Home"],
    [answer({ pid: 4 }), "进程"],
    [{ schemaVersion: 1 }, "应答"],
  ] as const) {
    const refused = await ask(body);
    expect(refused).toMatchObject({ answered: false });
    if (refused.answered) throw new Error("expected a refusal");
    expect(refused.reason).toContain(expected);
  }
  const rejected = await ask(answer(), 403);
  expect(rejected).toMatchObject({ answered: false });
  if (rejected.answered) throw new Error("expected a refusal");
  expect(rejected.reason).toContain("403");
  const unreachable = await challengeInstanceLiveness({ runtimeUrl: "http://127.0.0.1:19876", instanceId: "i-one", profileId: "web",
    pid: 4242, homeRoot, fetchImpl: (async () => { throw new Error("synthetic refusal"); }) as unknown as typeof fetch });
  expect(unreachable).toMatchObject({ answered: false });
  if (unreachable.answered) throw new Error("expected a refusal");
  expect(unreachable.reason).toContain("没有应答");
  // The challenge names the process the Engine expects, so the instance can deny a mismatch.
  const calls: unknown[] = [];
  await challengeInstanceLiveness({ runtimeUrl: "http://127.0.0.1:19876", instanceId: "i-one", profileId: "web", pid: 4242, homeRoot,
    fetchImpl: (async (_url: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return new Response(JSON.stringify(answer()), { status: 200 }); }) as unknown as typeof fetch });
  expect(calls[0]).toEqual({ schemaVersion: 1, instanceId: "i-one", profileId: "web", pid: 4242, homeRoot });
});
