import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { MaintenanceExternalLifecycleProvider } from "../src/external-lifecycle-provider.js";
import { canRecoverAfterReboot, recoverySystemEvidence, scopedRecoveryRuns, type RecoverySystemEvidence } from "../src/lifecycle-recovery.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const request = { schemaVersion: 1, phase: "recoverBeforeStart", instanceId: "instance-A", profileId: "web" };
const bootedAt = "2026-09-19T01:00:00.000Z";
const previous = "2026-09-18T01:00:00.000Z";
async function fixture(options: { createdAt?: string; state?: string; exit?: boolean; identity?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "SYNTHETIC-startup-recovery-")); roots.push(root);
  await mkdir(join(root, "external-lifecycle-handles"));
  const path = join(root, "external-lifecycle-handles/maintenance-test.json");
  const processIdentity = { pid: 123, startedAt: previous, bootedAt: "2026-09-17T00:00:00.000Z" };
  const stored = {
    schemaVersion: 1, handle: "maintenance-test", ownerClientId: "owner", runtimeClientId: "runtime", runId: "run-test",
    leaseId: "lease", temporaryPersistenceRootId: "temp", persistenceRoot: join(root, "sessions"), patchPath: join(root, "patch.yml"),
    dshVersion: "0.1.5-rc.2", maintenanceEndpoint: "http://127.0.0.1:12345", createdAt: options.createdAt ?? previous,
    state: "prepared", runtimeOrigin: null, shutdownAcceptedAt: null, finalReceipt: null, lastError: null,
    ...(options.exit ? { exitObservedAt: "2026-09-19T01:01:00.000Z" } : {}),
    ...(options.identity ? { processIdentity } : {}),
  };
  await writeFile(path, JSON.stringify(stored));
  const calls: Array<{ path: string; body: any }> = [];
  const recoveryRuns = vi.fn(async (_root: string, instance: string, profile: string) => {
    expect(instance).toBe("instance-A"); expect(profile).toBe("web");
    return [{ id: "run-test", state: options.state ?? "running", startedAt: stored.createdAt }];
  });
  const systemEvidence = vi.fn(async (_pid?: number): Promise<RecoverySystemEvidence> => ({ bootedAt, process: null }));
  let failClose = false;
  let closeState = "recovered";
  const provider = new MaintenanceExternalLifecycleProvider(root, {
    recoveryRuns, systemEvidence, clock: () => "2026-09-19T02:00:00.000Z",
    connection: async () => ({ origin: "http://127.0.0.1:12345", token: "x".repeat(32) }),
    fetch: async (input, init) => {
      calls.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(failClose ? { error: { message: "synthetic offline" } } : { run: { state: closeState, removedProjection: true } }), { status: failClose ? 503 : 200 });
    },
  });
  return { provider, calls, path, systemEvidence, processIdentity, fail: (value: boolean) => { failClose = value; }, state: (value: string) => { closeState = value; } };
}

it("recovers a legacy previous-boot run through its owner and saves the final receipt", async () => {
  const f = await fixture();
  await expect(f.provider.handle(request)).resolves.toEqual({ schemaVersion: 1, ok: true });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.body).toMatchObject({ clientId: "owner", runId: "run-test", reason: "recovery" });
  expect(JSON.parse(await readFile(f.path, "utf8"))).toMatchObject({ state: "finalized", finalReceipt: { disposition: "recovered" } });
});

it("never treats an absent PID in the same boot as proof that descendants exited", async () => {
  const f = await fixture({ createdAt: "2026-09-19T01:01:00.000Z", identity: true });
  await expect(f.provider.handle(request)).rejects.toMatchObject({ code: "RUNTIME_EXIT_UNCONFIRMED" });
  expect(f.calls).toHaveLength(0);
});

it("blocks a matching live process and preserves its handle", async () => {
  const f = await fixture({ createdAt: "2026-09-19T01:01:00.000Z", identity: true });
  f.systemEvidence.mockResolvedValue({ bootedAt, process: f.processIdentity });
  await expect(f.provider.handle(request)).rejects.toMatchObject({ code: "RUNTIME_STILL_RUNNING" });
  expect(f.calls).toHaveLength(0);
});

it("retains exit evidence when recovery fails, then retries on the next start", async () => {
  const f = await fixture({ createdAt: "2026-09-19T01:01:00.000Z" });
  f.fail(true);
  await expect(f.provider.handle({ schemaVersion: 1, phase: "afterExit", handle: "maintenance-test", exitCode: null, requestedStop: false, forced: false })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  expect(JSON.parse(await readFile(f.path, "utf8"))).toMatchObject({ exitObservedAt: "2026-09-19T02:00:00.000Z", finalReceipt: null });
  f.fail(false);
  await f.provider.handle(request);
  expect(f.systemEvidence).not.toHaveBeenCalled();
  expect(f.calls).toHaveLength(2);
});

it("reconciles a lost successful response without repeating committed recovery writes", async () => {
  const f = await fixture({ state: "recovered" });
  await f.provider.handle(request);
  await f.provider.handle(request);
  expect(f.calls).toHaveLength(0);
  expect(f.systemEvidence).not.toHaveBeenCalled();
});

it("rejects contradictory cleanup acknowledgements", async () => {
  const f = await fixture(); f.state("running");
  await expect(f.provider.handle(request)).rejects.toMatchObject({ code: "BROKER_CLOSE_INVALID" });
  expect(JSON.parse(await readFile(f.path, "utf8"))).toMatchObject({ finalReceipt: null });
});

it("records process creation identity, not only a reusable PID", async () => {
  const f = await fixture();
  f.systemEvidence.mockResolvedValue({ bootedAt, process: f.processIdentity });
  await f.provider.handle({ schemaVersion: 1, phase: "started", handle: "maintenance-test", processId: 123 });
  expect(JSON.parse(await readFile(f.path, "utf8"))).toMatchObject({ processIdentity: f.processIdentity });
  f.systemEvidence.mockResolvedValue({ bootedAt, process: { ...f.processIdentity, startedAt: bootedAt } });
  await expect(f.provider.handle({ schemaVersion: 1, phase: "started", handle: "maintenance-test", processId: 123 })).rejects.toMatchObject({ code: "PROCESS_CONFLICT" });
});

it("fails closed when OS evidence cannot be obtained", async () => {
  const f = await fixture(); f.systemEvidence.mockRejectedValue(new Error("access denied"));
  await expect(f.provider.handle(request)).rejects.toThrow("access denied");
  expect(f.calls).toHaveLength(0);
});

it("rejects invalid or ambiguous boot times", () => {
  expect(canRecoverAfterReboot(previous, previous, bootedAt, "2026-09-19T02:00:00Z")).toBe(true);
  expect(canRecoverAfterReboot("invalid", previous, bootedAt, bootedAt)).toBe(false);
  expect(canRecoverAfterReboot(bootedAt, previous, bootedAt, bootedAt)).toBe(false);
  expect(canRecoverAfterReboot(previous, previous, bootedAt, previous)).toBe(false);
});

it("reads only the selected instance/profile, without modifying its metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "SYNTHETIC-recovery-scope-")); roots.push(root);
  await writeFile(join(root, "config.yaml"), "schemaVersion: 1\ndatabaseFile: metadata.sqlite\ninstances: {}\n");
  const path = join(root, "metadata.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE projection_runs(id TEXT,instance_id TEXT,profile_id TEXT,state TEXT,started_at TEXT)");
  const insert = db.prepare("INSERT INTO projection_runs VALUES (?,?,?,?,?)");
  insert.run("mine", "A", "web", "running", previous);
  insert.run("other-instance", "B", "web", "running", previous);
  insert.run("other-profile", "A", "desktop", "running", previous);
  insert.run("quarantined", "A", "web", "quarantined", previous);
  db.close();
  const before = await readFile(path);
  expect(await scopedRecoveryRuns(root, "A", "web")).toEqual([{ id: "mine", state: "running", startedAt: previous }, { id: 'quarantined', state: 'quarantined', startedAt: previous }]);
  expect(await readFile(path)).toEqual(before);
});

it.runIf(process.platform === "win32")("reads the real OS boot and current process creation identity", async () => {
  const evidence = await recoverySystemEvidence(process.pid);
  expect(evidence.process?.pid).toBe(process.pid);
  expect(Date.parse(evidence.bootedAt)).toBeLessThanOrEqual(Date.now());
  expect(Date.parse(evidence.process!.startedAt)).toBeGreaterThanOrEqual(Date.parse(evidence.bootedAt));
}, 20_000);

it("does not prepare a new runtime while old exit evidence is missing", async () => {
  const f = await fixture({ createdAt: "2026-09-19T01:01:00.000Z" });
  await expect(f.provider.handle({ ...request, phase: "prepare", runtimeVersion: "0.1.2-alpha.2", web: true })).rejects.toMatchObject({ code: "RUNTIME_EXIT_UNCONFIRMED" });
  expect(f.calls).toHaveLength(0);
});
