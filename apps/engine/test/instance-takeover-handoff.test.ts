import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { takeoverHandoffSchema, type TakeoverHandoff } from "@linmu/dsh-session-contracts";
import {
  claimTakeoverHandoff, listTakeoverHandoffs, TAKEOVER_HANDOFF_DIRECTORY, takeoverHandoffPath, writeTakeoverHandoff,
} from "../src/instance-lease.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function stateRoot() { const root = await mkdtemp(join(tmpdir(), "dsh-takeover-")); roots.push(root); return root; }

const handoff = (over: Record<string, unknown> = {}): TakeoverHandoff => takeoverHandoffSchema.parse({ schemaVersion: 1,
  ticketId: "ticket-one", instanceId: "i-one", profileId: "web", runId: "run-one", runtimeClientId: "plugin-abc",
  ownerClientId: "engine-abc", temporaryPersistenceRootId: "projection:run-one", maintenanceEndpoint: "http://127.0.0.1:19876",
  dshVersion: "0.1.5-rc.2", adapterId: "dsh-0.1.5", nativeMode: "persistent-native-v1", createdAt: "2026-09-21T10:00:00.000Z",
  claimedAt: null, ...over });

it("publishes a handoff atomically and lists only what is still waiting", async () => {
  const root = await stateRoot();
  const path = await writeTakeoverHandoff(root, handoff());
  expect(path).toBe(join(root, TAKEOVER_HANDOFF_DIRECTORY, "ticket-one.json"));
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ ticketId: "ticket-one", claimedAt: null });
  await writeTakeoverHandoff(root, handoff({ ticketId: "ticket-two" }));
  expect((await listTakeoverHandoffs(root)).map(item => item.ticketId).sort()).toEqual(["ticket-one", "ticket-two"]);
  expect(await listTakeoverHandoffs(join(root, "missing"))).toEqual([]);
  // A handoff the Engine could not have written is refused rather than stored.
  await expect(writeTakeoverHandoff(root, { ...handoff(), runtimeClientId: "" } as TakeoverHandoff)).rejects.toThrow();
});

it("lets exactly one process claim a prepared run", async () => {
  const root = await stateRoot();
  await writeTakeoverHandoff(root, handoff());
  const first = await claimTakeoverHandoff(root, { ticketId: "ticket-one", instanceId: "i-one", profileId: "web", pid: 42,
    now: "2026-09-21T10:01:00.000Z" });
  expect(first).toMatchObject({ claimed: true, handoff: { runId: "run-one", runtimeClientId: "plugin-abc", claimedAt: "2026-09-21T10:01:00.000Z" } });
  // The run is single-attach, so the second claim has to be refused here.
  const second = await claimTakeoverHandoff(root, { ticketId: "ticket-one", instanceId: "i-one", profileId: "web", pid: 43 });
  expect(second).toMatchObject({ claimed: false });
  if (second.claimed) throw new Error("expected a refusal");
  expect(second.reason).toContain("已被领取");
  // The marker survives a restart, so a restart cannot attach the same run twice.
  expect(JSON.parse(await readFile(takeoverHandoffPath(root, "ticket-one"), "utf8")).claimedAt).toBe("2026-09-21T10:01:00.000Z");
});

it("refuses a ticket that is unknown, unreadable or meant for another instance", async () => {
  const root = await stateRoot();
  const missing = await claimTakeoverHandoff(root, { ticketId: "nope", instanceId: "i-one", profileId: "web", pid: 42 });
  expect(missing).toMatchObject({ claimed: false });
  if (missing.claimed) throw new Error("expected a refusal");
  expect(missing.reason).toContain("不存在");
  await writeTakeoverHandoff(root, handoff());
  const otherInstance = await claimTakeoverHandoff(root, { ticketId: "ticket-one", instanceId: "i-two", profileId: "web", pid: 42 });
  expect(otherInstance).toMatchObject({ claimed: false });
  const otherProfile = await claimTakeoverHandoff(root, { ticketId: "ticket-one", instanceId: "i-one", profileId: "other", pid: 42 });
  expect(otherProfile).toMatchObject({ claimed: false });
  await mkdir(join(root, TAKEOVER_HANDOFF_DIRECTORY), { recursive: true });
  await (await import("node:fs/promises")).writeFile(takeoverHandoffPath(root, "broken"), "{ not json");
  expect(await claimTakeoverHandoff(root, { ticketId: "broken", instanceId: "i-one", profileId: "web", pid: 42 }))
    .toMatchObject({ claimed: false, reason: expect.stringContaining("不存在") });
});

it("keeps the takeover decision honest: not running, refusing or unavailable means no handoff", async () => {
  // The decision lives in the integration service; this pins the contract it depends on.
  const { inspectInstanceLease } = await import("../src/instance-lease.js");
  const root = await stateRoot();
  const { writeInstanceLease } = await import("../src/instance-lease.js");
  await writeInstanceLease(root, { schemaVersion: 1, instanceId: "i-one", profileId: "web", pid: 42,
    processStartedAt: "2026-09-21T09:00:00.000Z", homeRoot: "C:\\home", runtimeUrl: "http://127.0.0.1:1",
    state: "attached", attachedRunId: "run-existing", updatedAt: "2026-09-21T10:00:00.000Z" });
  const running = await inspectInstanceLease(root, { instanceId: "i-one", profileId: "web",
    processEvidence: vi.fn(async () => ({ bootedAt: "2026-09-21T08:00:00.000Z", process: { pid: 42, startedAt: "2026-09-21T09:00:00.000Z", bootedAt: "2026-09-21T08:00:00.000Z" } })) });
  // Running but already attached: the Engine must recover that run first, not prepare a second one.
  expect(running).toMatchObject({ decision: "running", attachedRunId: "run-existing" });
  expect(running.reason).toContain("恢复该运行");
  const stopped = await inspectInstanceLease(root, { instanceId: "i-one", profileId: "web",
    processEvidence: vi.fn(async () => ({ bootedAt: "2026-09-21T08:00:00.000Z", process: null })) });
  expect(stopped.decision).toBe("not-running");
  // With no live instance there is no ticket to write.
  expect(await listTakeoverHandoffs(root)).toEqual([]);
});
