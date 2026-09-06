import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFixtureSandbox } from "../../test-support/src/index.js";
import { MaintenanceWriteCoordinator, assertMaintenanceDatabaseOwnership, offlineMaintenanceOperation } from "../src/write-coordinator.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const fixture = await createFixtureSandbox("sm05-write-coordination");
  cleanup.push(fixture.cleanup);
  const writes = MaintenanceWriteCoordinator.acquire(fixture.root);
  cleanup.push(async () => { await writes.drain(); writes.close(); });
  return { ...fixture, writes };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

it("holds the whole physical object-to-reference window, queues other work and reenters without deadlock", async () => {
  const { writes } = await setup();
  const physical = gate();
  const finish = gate();
  const order: string[] = [];
  const importCommit = writes.run("import", async () => {
    order.push("object-put"); physical.release(); await finish.promise;
    await writes.run("store", async () => {
      writes.assertInScope();
      await expect(writes.run("failed-nested", () => { throw new Error("handled"); })).rejects.toThrow("handled");
      order.push("reference-commit");
    });
  });
  await physical.promise;
  const gc = writes.run("retention-execution", () => { order.push("fresh-reference-check"); order.push("physical-quarantine"); });
  expect(order).toEqual(["object-put"]);
  finish.release(); await Promise.all([importCommit, gc]);
  expect(order).toEqual(["object-put", "reference-commit", "fresh-reference-check", "physical-quarantine"]);
});

it("cancels a queued write without later running it and invalidates evidence across generations", async () => {
  const { writes } = await setup();
  const hold = gate(); const started = gate();
  const first = writes.run("runtime", async () => { started.release(); await hold.promise; });
  await started.promise;
  const controller = new AbortController();
  let ran = false;
  const cancelled = writes.run("import", () => { ran = true; }, controller.signal);
  controller.abort(new Error("cancelled"));
  await expect(cancelled).rejects.toThrow("cancelled");
  hold.release(); await first; await writes.drain(); expect(ran).toBe(false);
  const old = await writes.run("plan", () => writes.captureEvidence());
  await writes.run("retention-execution", () => {
    expect(() => writes.assertEvidence(old)).toThrow("WRITER_EVIDENCE_CHANGED");
    writes.assertEvidence(writes.captureEvidence());
  });
});

it("expired asynchronous contexts cannot retain authority and must acquire a new generation", async () => {
  const { writes } = await setup();
  const delayed = gate();
  let work!: Promise<void>;
  let generation = 0;
  await writes.run("original", () => {
    generation = writes.captureEvidence().generation;
    work = delayed.promise.then(async () => {
      expect(() => writes.assertInScope()).toThrow("WRITER_SCOPE_REQUIRED");
      await writes.run("new", () => expect(writes.captureEvidence().generation).toBeGreaterThan(generation));
    });
  });
  delayed.release(); await work;
});

it("rejects another owner and never steals a live or unrecognized owner", async () => {
  const { root, writes } = await setup();
  expect(() => MaintenanceWriteCoordinator.acquire(root, "offline")).toThrow("WRITER_OWNER_CONFLICT");
  expect(() => MaintenanceWriteCoordinator.recoverDeadOwner(root, writes.captureEvidence().ownerId)).toThrow("WRITER_OWNER_ACTIVE");
  const descriptor = JSON.parse(await readFile(join(root, "maintenance-writer.json"), "utf8"));
  await writeFile(join(root, "maintenance-writer.json"), JSON.stringify({ ...descriptor, hostname: "unknown-host" }));
  expect(() => MaintenanceWriteCoordinator.recoverDeadOwner(root, descriptor.ownerId)).toThrow("WRITER_OWNER_UNKNOWN");
  await writeFile(join(root, "maintenance-writer.json"), JSON.stringify(descriptor));
});

it("recovers a proven dead process by explicit owner identity, preserving crash evidence", async () => {
  const fixture = await createFixtureSandbox("sm05-dead-owner"); cleanup.push(fixture.cleanup);
  const child = spawn(process.execPath, ["--input-type=module", "-e", "console.log(process.pid);"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let pid = ""; child.stdout.on("data", (data) => { pid += data; }); await once(child, "exit");
  const first = MaintenanceWriteCoordinator.acquire(fixture.root);
  const owner = MaintenanceWriteCoordinator.inspect(fixture.root); first.close();
  await writeFile(join(fixture.root, "maintenance-writer.json"), JSON.stringify({ ...owner, pid: Number(pid.trim()) }));
  expect(() => assertMaintenanceDatabaseOwnership(join(fixture.root, "metadata.sqlite"))).toThrow("WRITER_OWNER_CONFLICT");
  MaintenanceWriteCoordinator.recoverDeadOwner(fixture.root, owner.ownerId);
  const recovered = MaintenanceWriteCoordinator.acquire(fixture.root);
  expect(recovered.captureEvidence().ownerId).not.toBe(owner.ownerId);
  expect(JSON.parse(await readFile(join(fixture.root, `maintenance-writer.dead-${owner.ownerId}.json`), "utf8")).pid).toBe(Number(pid.trim()));
  recovered.close();
});

it("candidate operations reuse the Engine queue and hold it through manifest registration", async () => {
  const { root, writes } = await setup();
  const operation = offlineMaintenanceOperation(async (_input: { stateRoot: string }) => {
    writes.assertInScope();
    await Promise.resolve();
    writes.assertEvidence(writes.captureEvidence());
    return "manifest-registered";
  }, "candidate-registration");
  expect(await operation({ stateRoot: root })).toBe("manifest-registered");
  expect(writes.captureEvidence().activeScope).toBeNull();
});

it("applies bounded backpressure without admitting a delayed overflow mutation", async () => {
  const fixture = await createFixtureSandbox("sm05-queue-limit"); cleanup.push(fixture.cleanup);
  const writes = MaintenanceWriteCoordinator.acquire(fixture.root, "engine", { maxPending: 1 });
  cleanup.push(async () => { await writes.drain(); writes.close(); });
  const hold = gate(); const entered = gate();
  const first = writes.run("first", async () => { entered.release(); await hold.promise; });
  await entered.promise;
  let overflowRan = false;
  await expect(writes.run("overflow", () => { overflowRan = true; })).rejects.toThrow("WRITER_QUEUE_FULL");
  hold.release(); await first;
  expect(overflowRan).toBe(false);
  expect(await writes.run("retry", () => "accepted")).toBe("accepted");
});

it("rejects asynchronous children of synchronous operations without granting detached write authority", async () => {
  const { writes } = await setup();
  let child!: Promise<void>; let ran = false;
  writes.runSync("synchronous", () => { child = writes.run("async-child", () => { ran = true; }); });
  await expect(child).rejects.toThrow("WRITER_SYNC_ASYNC");
  expect(ran).toBe(false);
  expect(() => writes.runSync("invalid-result", () => Promise.resolve())).toThrow("WRITER_SYNC_ASYNC");
  await writes.run("async-parent", () => writes.runSync("sync-child", () => writes.assertInScope()));
});
