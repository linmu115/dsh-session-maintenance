import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { JobRunner } from "../src/jobs/job-runner.js";
import { CodexCanonicalImportService } from "../src/codex-canonical-import.js";
import { SqliteCodexProjectPort } from "../src/sqlite-codex-project-port.js";
import { SqliteCanonicalRepository } from "@linmu/dsh-session-store";
import { createEngineFixture, hashTree, runCli } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const request = { operationId: "sm05-fixture-import", instanceIds: ["codex-fixture"], mode: "content" as const };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

it("uses authenticated jobs and the online CLI, deduplicates retries, and observes titles without touching source bodies", async () => {
  const fixture = await createEngineFixture("sm05-import-api"); cleanups.push(fixture.cleanupAll);
  const server = await fixture.startServer();
  const client = new MaintenanceClient({ origin: server.origin, token: server.token });
  const before = await hashTree(fixture.codexHome);
  expect((await fetch(`${server.origin}/v1/jobs/codex-import`, { method: "POST", body: JSON.stringify(request) })).status).toBe(401);
  const job = await client.importCodex(request);
  await server.jobs.waitForImport(job.id);
  const database = fixture.engine.repository.database;
  const versions = () => (database.prepare("SELECT COUNT(*) AS count FROM session_versions").get() as { count: number }).count;
  expect(versions()).toBe(1);
  expect((await client.importCodex(request)).id).toBe(job.id);
  const repeated = await client.importCodex({ ...request, operationId: "second-observation" });
  await server.jobs.waitForImport(repeated.id);
  expect(versions()).toBe(1);
  const conflict = await fetch(`${server.origin}/v1/jobs/codex-import`, {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...request, mode: "titles" }),
  });
  expect(conflict.status).toBe(409);
  const cli = await runCli(["--state-root", fixture.stateRoot, "canonical", "import", "--instance", "codex-fixture", "--operation-id", "online-cli"], fixture);
  expect(cli).toMatchObject({ exitCode: 0, stderr: "" });
  expect(versions()).toBe(1);
  expect(await hashTree(fixture.codexHome)).toBe(before);
  const source = new DatabaseSync(join(fixture.codexHome, "state_5.sqlite"));
  try { source.prepare("UPDATE threads SET name = ?, title = ? WHERE id = 'thread-fixture'").run("Renamed fixture", "Renamed fixture"); } finally { source.close(); }
  const renamed = await hashTree(fixture.codexHome);
  const titles = await client.importCodex({ ...request, operationId: "title-observation", mode: "titles" });
  await server.jobs.waitForImport(titles.id);
  expect(versions()).toBe(2);
  expect(database.prepare("SELECT display_title FROM logical_sessions").get()).toMatchObject({ display_title: "Renamed fixture" });
  expect(await hashTree(fixture.codexHome)).toBe(renamed);
  const offline = await runCli(["--state-root", fixture.stateRoot, "canonical", "import", "--instance", "codex-fixture", "--offline"], fixture);
  expect(offline.exitCode).not.toBe(0);
  expect(offline.stderr).toContain("WRITER_OWNER_CONFLICT");
  const listed = await client.listCodexImports();
  expect(listed).toHaveLength(4);
  expect(listed.every((item) => item.request.kind === "codex-import" && item.latestEvent?.type === "completed")).toBe(true);
  for (const query of ["kind=scan", "kind=codex-import&limit=101", "kind=codex-import&root=forbidden", "kind=codex-import&limit=1&limit=2"]) {
    expect((await fetch(`${server.origin}/v1/jobs?${query}`, { headers: { authorization: `Bearer ${server.token}` } })).status).toBe(400);
  }
  expect((await fetch(`${server.origin}/v1/jobs?kind=codex-import`)).status).toBe(401);
  const limited = await fetch(`${server.origin}/v1/jobs?kind=codex-import&limit=1`, { headers: { authorization: `Bearer ${server.token}` } });
  expect(await limited.json()).toHaveLength(1);
  await fixture.stop();
  cleanups.pop(); cleanups.push(fixture.cleanup);
  const standalone = await runCli(["--state-root", fixture.stateRoot, "canonical", "import", "--instance", "codex-fixture", "--mode", "titles", "--offline"], fixture);
  expect(standalone).toMatchObject({ exitCode: 0, stderr: "" });
  expect(await hashTree(fixture.codexHome)).toBe(renamed);
});

it("keeps actual object creation and canonical references in one scope before retention can inspect", async () => {
  const fixture = await createEngineFixture("sm05-import-object-window"); cleanups.push(fixture.cleanupAll);
  const physical = gate(); const finish = gate();
  const original = fixture.engine.objectStore.put.bind(fixture.engine.objectStore);
  let first = true;
  vi.spyOn(fixture.engine.objectStore, "put").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (first) { first = false; fixture.engine.writes!.assertInScope(); physical.release(); await finish.promise; }
    return result;
  });
  const job = await fixture.engine.runWrite("job-enqueue", () => fixture.engine.jobs.enqueueCodexImport(request));
  const result = fixture.engine.jobs.waitForImport(job.id);
  await physical.promise;
  let inspected = false;
  const retention = fixture.engine.runWrite("retention-execution", () => {
    inspected = true;
    expect(fixture.engine.repository.database.prepare("SELECT COUNT(*) AS count FROM logical_sessions").get()).toMatchObject({ count: 1 });
  });
  expect(inspected).toBe(false);
  finish.release(); await Promise.all([result, retention]);
  await fixture.engine.jobs.stopImports(); await fixture.engine.writes!.drain();
});

it("signals cancellation while waiting, persists it, resumes the same job, and requeues shutdown interruption", async () => {
  const fixture = await createEngineFixture("sm05-import-cancel"); cleanups.push(fixture.cleanupAll);
  const entered = gate(); const signalSeen = gate(); const hold = gate();
  let calls = 0;
  const runner = new JobRunner({ ...fixture.engine, runWrite: fixture.engine.runWrite.bind(fixture.engine), importCodex: async (_input, signal) => {
    calls += 1;
    if (calls > 1) return { resumed: true };
    entered.release();
    signal!.addEventListener("abort", () => signalSeen.release(), { once: true });
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    return null;
  }} as never, fixture.engine.jobStore);
  const job = await fixture.engine.runWrite("enqueue", () => runner.enqueueCodexImport(request));
  const cancelledResult = runner.waitForImport(job.id).catch((error) => error as Error);
  await entered.promise;
  const busy = fixture.engine.runWrite("runtime-commit", () => hold.promise);
  const cancel = runner.cancelCodexImport(job.id);
  await signalSeen.promise;
  hold.release(); await Promise.all([busy, cancel]);
  expect((await cancelledResult).message).toContain("JOB_CANCELLED");
  await runner.stopImports();
  await fixture.engine.runWrite("resume", () => runner.resumeCodexImport(job.id));
  expect(await runner.waitForImport(job.id)).toEqual({ resumed: true });
  await runner.stopImports();
  const interrupted = fixture.engine.jobStore.createCodexImport({ ...request, operationId: "process-restart" });
  fixture.engine.jobStore.markRunning(interrupted.id);
  const restarted = new JobRunner(fixture.engine, fixture.engine.jobStore);
  await fixture.engine.runWrite("recovery", () => { restarted.start(); restarted.start(); });
  await restarted.waitForImport(interrupted.id); await restarted.stopImports();
  expect(fixture.engine.jobStore.listEvents(interrupted.id).filter((event) => event.type === "queued")).toHaveLength(2);
  expect(fixture.engine.jobStore.listEvents(interrupted.id).filter((event) => event.type === "completed")).toHaveLength(1);
  await fixture.engine.writes!.drain();
});

it("rejects a head changed during source reading before any stale import object or reference write", async () => {
  const fixture = await createEngineFixture("sm05-import-head-race"); cleanups.push(fixture.cleanupAll);
  await fixture.engine.importCodex(request);
  const database = fixture.engine.repository.database;
  const importer = new CodexCanonicalImportService({
    canonicalEngine: fixture.engine.canonicalEngine,
    projectPort: new SqliteCodexProjectPort(new SqliteCanonicalRepository(database)),
    writes: fixture.engine.writes!, fixtureGuard: fixture.fixturePolicy,
  });
  const result = importer.sync({ instance: fixture.engine.instances[0]!, onStatus: async (event) => {
    if (event.stage === "codex.classification") await fixture.engine.canonicalEngine.retitleCodexMirror({
      logicalSessionId: event.logicalSessionId as never, title: "Concurrent title", appliedAt: "2026-09-06T00:00:00.000Z",
    });
  }});
  await expect(result).rejects.toThrow("IMPORT_HEAD_CHANGED");
  expect(database.prepare("SELECT display_title FROM logical_sessions").get()).toMatchObject({ display_title: "Concurrent title" });
  expect(database.prepare("SELECT COUNT(*) AS count FROM session_versions").get()).toMatchObject({ count: 2 });
  await fixture.engine.writes!.drain();
});

it("serializes sibling canonical commits and their nested Store transactions without losing either head", async () => {
  const fixture = await createEngineFixture("sm05-sibling-commits"); cleanups.push(fixture.cleanupAll);
  const common = { title: "Sibling", tags: [], archivedAt: null, workspaceId: null, events: [], sourceCursor: null, observedAt: "2026-09-06T00:00:00.000Z" };
  await fixture.engine.runWrite("two-siblings", () => Promise.all([
    fixture.engine.canonicalEngine.observeCodex({ ...common, logicalSessionId: "ls-sibling-a" as never }),
    fixture.engine.canonicalEngine.observeCodex({ ...common, logicalSessionId: "ls-sibling-b" as never }),
  ]));
  await fixture.engine.runWrite("two-retitles", () => Promise.all([
    fixture.engine.canonicalEngine.retitleCodexMirror({ logicalSessionId: "ls-sibling-a" as never, title: "First", appliedAt: common.observedAt }),
    fixture.engine.canonicalEngine.retitleCodexMirror({ logicalSessionId: "ls-sibling-a" as never, title: "Last", appliedAt: common.observedAt }),
  ]));
  expect(fixture.engine.repository.database.prepare("SELECT id, display_title FROM logical_sessions ORDER BY id").all()).toEqual([
    { id: "ls-sibling-a", display_title: "Last" }, { id: "ls-sibling-b", display_title: "Sibling" },
  ]);
  expect(fixture.engine.repository.database.prepare("SELECT COUNT(*) AS count FROM session_versions").get()).toMatchObject({ count: 4 });
  await fixture.engine.writes!.drain();
});

it("stops an importing server with an open event stream and resumes its durable queued job offline", async () => {
  const fixture = await createEngineFixture("sm05-import-shutdown"); cleanups.push(fixture.cleanupAll);
  const entered = gate();
  vi.spyOn(fixture.engine, "importCodex").mockImplementation(async (_input, signal) => {
    entered.release();
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    return null;
  });
  const server = await fixture.startServer();
  const client = new MaintenanceClient({ origin: server.origin, token: server.token });
  const job = await client.importCodex(request);
  await entered.promise;
  const events = await fetch(`${server.origin}/v1/jobs/${job.id}/events`, { headers: { authorization: `Bearer ${server.token}` } });
  expect(events.status).toBe(200);
  await fixture.stop(); cleanups.pop(); cleanups.push(fixture.cleanup);
  const streamText = await events.text(); expect(streamText).toContain("running");
  const stored = new DatabaseSync(join(fixture.stateRoot, "metadata.sqlite"), { readOnly: true });
  try { expect(stored.prepare("SELECT status FROM jobs WHERE id = ?").get(job.id)).toMatchObject({ status: "queued" }); } finally { stored.close(); }
  const retry = await runCli(["--state-root", fixture.stateRoot, "canonical", "import", "--instance", "codex-fixture", "--operation-id", request.operationId, "--offline"], fixture);
  expect(retry).toMatchObject({ exitCode: 0, stderr: "" });
});
