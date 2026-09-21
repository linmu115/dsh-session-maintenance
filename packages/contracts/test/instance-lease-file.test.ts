import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  instanceLeaseSchema, maintenanceInstanceIdFor, type InstanceLease,
} from "../src/index.js";
// The file layer sits behind its own subpath precisely because it is Node-only; the barrel must
// stay safe for the browser Dashboard.
import {
  INSTANCE_LEASE_DIRECTORY, instanceLeasePath, listInstanceLeases, readInstanceLease,
  removeInstanceLease, writeInstanceLease,
} from "../src/instance-lease-file.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function stateRoot() { const root = await mkdtemp(join(tmpdir(), "dsh-lease-file-")); roots.push(root); return root; }

const lease = (over: Partial<InstanceLease> = {}): InstanceLease => instanceLeaseSchema.parse({ schemaVersion: 1, instanceId: "i-one",
  profileId: "web", pid: 1, processStartedAt: "2026-09-21T09:59:00.000Z", homeRoot: "C:\\home",
  runtimeUrl: "http://127.0.0.1:1", state: "idle", attachedRunId: null, updatedAt: "2026-09-21T10:00:00.000Z", ...over });

it("uses one path rule that both the instance and the Engine can derive without configuration", async () => {
  const root = await stateRoot();
  expect(instanceLeasePath(root, "i-one", "web")).toBe(join(root, INSTANCE_LEASE_DIRECTORY, "i-one__web.json"));
  // A name that cannot be a file name is reduced, not rejected, so a connection always has a handshake.
  expect(maintenanceInstanceIdFor("i/one", "web")).toBe("i-one__web");
  expect(maintenanceInstanceIdFor("i.one_2-3", "web")).toBe("i.one_2-3__web");
});

it("round-trips a lease atomically and treats a missing file as absent", async () => {
  const root = await stateRoot();
  const path = await writeInstanceLease(root, lease());
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ instanceId: "i-one", state: "idle" });
  expect(await readInstanceLease(root, "i-one", "web")).toMatchObject({ instanceId: "i-one", profileId: "web" });
  // Nothing else is left behind, and an absent or malformed lease is reported as absent rather than thrown.
  expect((await listInstanceLeases(root)).map(item => item.instanceId)).toEqual(["i-one"]);
  expect(await readInstanceLease(root, "i-two", "web")).toBeUndefined();
  await writeFile(instanceLeasePath(root, "i-two", "web"), "not json");
  expect(await readInstanceLease(root, "i-two", "web")).toBeUndefined();
  expect(await listInstanceLeases(root)).toHaveLength(1);
  await removeInstanceLease(root, "i-one", "web");
  expect(await listInstanceLeases(root)).toEqual([]);
  await expect(removeInstanceLease(root, "i-one", "web")).resolves.toBeUndefined();
});

it("refuses to publish a lease that the Engine could not verify", async () => {
  const root = await stateRoot();
  // A non-loopback endpoint, a relative Home or a missing process start time is not a handshake.
  await expect(writeInstanceLease(root, { ...lease(), runtimeUrl: "http://10.0.0.5:1" } as InstanceLease)).rejects.toThrow();
  await expect(writeInstanceLease(root, { ...lease(), processStartedAt: "" } as InstanceLease)).rejects.toThrow();
  expect(await listInstanceLeases(root)).toEqual([]);
});
