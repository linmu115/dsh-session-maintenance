import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexReadAdapter, readCodexDesktopProjectDirectory } from "@linmu/dsh-adapter-codex-read";
import { SqliteCanonicalRepository } from "@linmu/dsh-session-store";
import { CodexCanonicalImportService, applyCodexCanonicalImportPlan, type CodexProjectScopeProvider } from "../src/codex-canonical-import.js";
import { CodexImportService } from "../src/codex-import-service.js";
import { CodexProjectObserver } from "../src/codex-project-observer.js";
import { SqliteCodexProjectPort } from "../src/sqlite-codex-project-port.js";
import { createEngineFixture, hashTree } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(brokenExcluded = true) {
  const f = await createEngineFixture("codex-strict-project-import"); cleanups.push(f.cleanupAll);
  const instance = f.engine.instances[0]!;
  const nativeState = {
    "local-projects": {
      "desktop-a": { id: "desktop-a", name: "Same name", rootPaths: ["C:\\fixture\\workspace"] },
      "desktop-b": { id: "desktop-b", name: "Same name", rootPaths: ["C:\\fixture\\workspace"] },
    },
    "thread-project-assignments": {
      "thread-fixture": { projectId: "desktop-a", projectKind: "local" },
      "thread-other": { projectId: "desktop-b", projectKind: "local" },
    } as Record<string, { projectId: string; projectKind: string }>,
  };
  const save = () => writeFile(join(f.codexHome, ".codex-global-state.json"), JSON.stringify(nativeState));
  const sql = (query: string) => {
    const db = new DatabaseSync(join(f.codexHome, "state_5.sqlite"));
    try { db.exec(query); } finally { db.close(); }
  };
  const clone = async (id: string, writeBody = true) => {
    const db = new DatabaseSync(join(f.codexHome, "state_5.sqlite"));
    try {
      const original = db.prepare("SELECT * FROM threads WHERE id='thread-fixture'").get()!;
      const row = { ...original, id, rollout_path: `rollouts/${id}.jsonl`, title: id, name: id };
      const columns = Object.keys(row);
      db.prepare(`INSERT INTO threads (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
    } finally { db.close(); }
    if (writeBody) await writeFile(join(f.codexHome, `rollouts/${id}.jsonl`),
      (await readFile(join(f.codexHome, "rollouts/thread-fixture.jsonl"), "utf8")).replaceAll("thread-fixture", id));
  };
  await clone("thread-other", !brokenExcluded);
  await clone("thread-with-same-cwd", false);
  await save();
  let revision = 1;
  let projectIds: readonly string[] | undefined = ["desktop-a"];
  const projectScope: CodexProjectScopeProvider = async () => projectIds === undefined ? undefined : ({
    revision, projectIds,
    directory: await readCodexDesktopProjectDirectory(instance, { fixtureGuard: f.fixturePolicy }),
  });
  const options = {
    canonicalEngine: f.engine.canonicalEngine,
    projectPort: new SqliteCodexProjectPort(new SqliteCanonicalRepository(f.engine.repository.database)),
    fixtureGuard: f.fixturePolicy,
    writes: f.engine.writes!, projectScope,
  };
  const importer = new CodexCanonicalImportService(options);
  const service = new CodexImportService({ ...options, instances: [instance], adapters: [new CodexReadAdapter({ fixtureGuard: f.fixturePolicy })] });
  const count = () => f.engine.repository.database.prepare("SELECT COUNT(*) AS count FROM logical_sessions").get();
  return {
    ...f, instance, nativeState, save, sql, clone, projectScope, options, importer, service, count,
    setRevision: (value: number) => { revision = value; },
    select: (value: readonly string[] | undefined) => { projectIds = value; },
  };
}

describe("strict Codex project import", () => {
  it("filters before probe/body observation, ignores same names and cwd, and records native project identity", async () => {
    const f = await fixture();
    const observe = vi.spyOn(CodexReadAdapter.prototype, "observe");
    const before = await hashTree(f.codexHome);
    const result = await f.importer.sync({ instance: f.instance });
    expect(result).toMatchObject({ scanned: 1, created: 1 });
    expect(observe.mock.calls.map(call => call[1].sessionId)).toEqual(["thread-fixture"]);
    expect(f.count()).toEqual({ count: 1 });
    expect(f.engine.repository.database.prepare("SELECT source_project_id,name FROM logical_projects").all()).toEqual([{ source_project_id: "desktop-a", name: "Same name" }]);
    expect(await hashTree(f.codexHome)).toBe(before);
  });

  it("treats an explicit empty selection as zero imports for bodies and titles", async () => {
    const f = await fixture(); f.select([]);
    const observe = vi.spyOn(CodexReadAdapter.prototype, "observe");
    const probe = vi.spyOn(CodexReadAdapter.prototype, "probe");
    await expect(f.importer.sync({ instance: f.instance })).resolves.toMatchObject({ scanned: 0, created: 0 });
    await expect(f.service.run({ operationId: "empty-titles", instanceIds: [f.instance.id], mode: "titles" })).resolves.toMatchObject({ instances: [{ scanned: 0 }] });
    expect(observe).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled(); expect(f.count()).toEqual({ count: 0 });
  });

  it.each(["revision", "native-member", "unconfigured"])("rejects %s changes after body observation before canonical writes", async mode => {
    const f = await fixture();
    await expect(f.importer.sync({ instance: f.instance, onStatus: async event => {
      if (event.stage !== "codex.classification") return;
      if (mode === "revision") f.setRevision(2);
      else if (mode === "unconfigured") f.select(undefined);
      else { f.nativeState["thread-project-assignments"]["thread-fixture"]!.projectId = "desktop-b"; await f.save(); }
    }})).rejects.toThrow(mode === "native-member" ? "IMPORT_PROJECT_MEMBERSHIP_CHANGED" : "IMPORT_PROJECT_SCOPE_CHANGED");
    expect(f.count()).toEqual({ count: 0 });
  });

  it("seals scoped plans for apply/retries and rejects applying them without the scope provider", async () => {
    const f = await fixture();
    const plan = await f.importer.plan({ instance: f.instance });
    await expect(applyCodexCanonicalImportPlan({ plan, canonicalEngine: f.options.canonicalEngine, projectPort: f.options.projectPort })).rejects.toThrow("IMPORT_PROJECT_SCOPE_REQUIRED");
    f.setRevision(2);
    await expect(f.importer.apply({ plan })).rejects.toThrow("IMPORT_PROJECT_SCOPE_CHANGED");
    expect(f.count()).toEqual({ count: 0 });
    await expect(f.importer.sync({ instance: f.instance })).resolves.toMatchObject({ created: 1 });
  });

  it("rechecks ownership after the head lookup before the first body read", async () => {
    const f = await fixture();
    const observe = vi.spyOn(CodexReadAdapter.prototype, "observe");
    vi.spyOn(f.options.canonicalEngine.store, "getSession").mockImplementationOnce(async () => {
      f.nativeState["thread-project-assignments"]["thread-fixture"]!.projectId = "desktop-b";
      await f.save();
      return undefined;
    });
    await expect(f.importer.sync({ instance: f.instance })).rejects.toThrow("IMPORT_PROJECT_MEMBERSHIP_CHANGED");
    expect(observe).not.toHaveBeenCalled();
    expect(f.count()).toEqual({ count: 0 });
  });

  it("rechecks native membership after an apply waits for the write queue", async () => {
    const f = await fixture(); const plan = await f.importer.plan({ instance: f.instance });
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const blocker = f.engine.runWrite("fixture-scope-race", async () => { entered(); await gate; });
    await ready;
    const apply = f.importer.apply({ plan });
    const rejected = expect(apply).rejects.toThrow("IMPORT_PROJECT_MEMBERSHIP_CHANGED");
    f.nativeState["thread-project-assignments"]["thread-fixture"]!.projectId = "desktop-b"; await f.save();
    release(); await blocker; await rejected;
    expect(f.count()).toEqual({ count: 0 });
  });

  it("keeps cancellation after source reads ahead of all canonical commits", async () => {
    const f = await fixture(); const controller = new AbortController();
    await expect(f.importer.sync({ instance: f.instance, signal: controller.signal, onStatus: event => {
      if (event.stage === "codex.classification") controller.abort(new Error("fixture-cancelled"));
    }})).rejects.toThrow("fixture-cancelled");
    expect(f.count()).toEqual({ count: 0 });
  });

  it("limits title-only repair to currently selected native members without reading bodies", async () => {
    const f = await fixture(false); f.select(["desktop-a", "desktop-b"]);
    await f.importer.sync({ instance: f.instance });
    f.select(["desktop-a"]);
    f.sql("UPDATE threads SET name='Selected renamed' WHERE id='thread-fixture'; UPDATE threads SET name='Excluded renamed' WHERE id='thread-other'");
    const observe = vi.spyOn(CodexReadAdapter.prototype, "observe");
    await expect(f.service.run({ operationId: "scoped-titles", instanceIds: [f.instance.id], mode: "titles" })).resolves.toMatchObject({ instances: [{ scanned: 1, advanced: 1 }] });
    const titles = f.engine.repository.database.prepare("SELECT display_title FROM logical_sessions ORDER BY display_title").all();
    expect(titles).toEqual([{ display_title: "Selected renamed" }, { display_title: "thread-other" }]);
    expect(observe).not.toHaveBeenCalled();
  });

  it("refuses unsafe native directories before touching any body", async () => {
    const f = await fixture();
    await writeFile(join(f.codexHome, ".codex-global-state.json"), "{broken");
    const observe = vi.spyOn(CodexReadAdapter.prototype, "observe");
    await expect(f.importer.sync({ instance: f.instance })).rejects.toThrow("IMPORT_PROJECT_DIRECTORY_UNSAFE");
    expect(observe).not.toHaveBeenCalled();
  });
});

describe("continuous scoped Codex observation", () => {
  it("skips unchanged bodies, discovers future members, and detects title, append, truncate and replacement changes", async () => {
    const f = await fixture();
    const observer = new CodexProjectObserver({ instances: [f.instance], projectScope: f.projectScope, importService: f.service });
    const observe = vi.spyOn(CodexReadAdapter.prototype, "observe");
    await observer.tick(); expect(observe).toHaveBeenCalledTimes(1);
    await observer.tick(); expect(observe).toHaveBeenCalledTimes(1);
    await f.clone("thread-new");
    f.nativeState["thread-project-assignments"]["thread-new"] = { projectId: "desktop-a", projectKind: "local" }; await f.save();
    await observer.tick(); expect(observe.mock.calls.map(call => call[1].sessionId)).toEqual(["thread-fixture", "thread-new"]);
    f.sql("UPDATE threads SET name='Renamed without timestamp' WHERE id='thread-fixture'");
    await observer.tick(); expect(observe).toHaveBeenCalledTimes(2);
    expect(f.engine.repository.database.prepare("SELECT display_title FROM logical_sessions WHERE display_title='Renamed without timestamp'").get()).toBeDefined();
    const path = join(f.codexHome, "rollouts/thread-fixture.jsonl");
    const original = await readFile(path, "utf8");
    await appendFile(path, JSON.stringify({ timestamp: "2026-09-06T01:00:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "New message" }] } }) + "\n");
    await observer.tick(); expect(observe).toHaveBeenCalledTimes(3);
    await writeFile(path, original); await observer.tick(); expect(observe).toHaveBeenCalledTimes(4);
    await writeFile(`${path}.replacement`, original);
    await rename(`${path}.replacement`, path); await observer.tick(); expect(observe).toHaveBeenCalledTimes(5);
    await observer.tick(); expect(observe).toHaveBeenCalledTimes(5);
    expect(observer.snapshot()).toMatchObject({ state: "idle", lastError: null });
    expect(observer.snapshot().lastSyncAt).not.toBeNull();
    expect(f.count()).toEqual({ count: 2 });
    await observer.stop();
    await observer.start(); await observer.tick(); expect(observe).toHaveBeenCalledTimes(7);
    await observer.stop();
  });

  it("clears removed membership cache and never falls back to all threads when active configuration disappears", async () => {
    const f = await fixture();
    const observe = vi.spyOn(CodexReadAdapter.prototype, "observe");
    await f.service.runChanged(f.instance.id);
    f.select([]); await f.service.runChanged(f.instance.id);
    f.select(["desktop-a"]); await f.service.runChanged(f.instance.id);
    expect(observe).toHaveBeenCalledTimes(2);
    f.select(undefined); await expect(f.service.runChanged(f.instance.id)).resolves.toMatchObject({ skippedUnconfigured: true });
    expect(observe).toHaveBeenCalledTimes(2);
    let reads = 0; f.select(["desktop-a"]);
    const service = new CodexImportService({ ...f.options, instances: [f.instance], adapters: [], projectScope: async (instance, signal) => {
      reads += 1;
      return reads === 1 ? f.projectScope(instance, signal) : undefined;
    }});
    await expect(service.runChanged(f.instance.id)).rejects.toThrow("IMPORT_PROJECT_SCOPE_CHANGED");
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("uses a constant number of native directory reads for an unchanged pass", async () => {
    const f = await fixture();
    for (let i = 0; i < 4; i += 1) {
      const id = `thread-count-${i}`; await f.clone(id);
      f.nativeState["thread-project-assignments"][id] = { projectId: "desktop-a", projectKind: "local" };
    }
    await f.save();
    const projectScope = vi.fn(f.projectScope);
    const service = new CodexImportService({ ...f.options, instances: [f.instance], adapters: [], projectScope });
    const observer = new CodexProjectObserver({ instances: [f.instance], projectScope, importService: service });
    await observer.tick(); projectScope.mockClear();
    await observer.tick();
    expect(projectScope).toHaveBeenCalledTimes(3);
    await observer.stop();
  });

  it("does not overlap ticks and aborts an active pass before stop resolves", async () => {
    const f = await fixture();
    let began!: () => void; const entered = new Promise<void>(resolve => { began = resolve; });
    const runChanged = vi.fn(async (_id: string, signal?: AbortSignal) => {
      began();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
      return null;
    });
    const clearChangeCache = vi.fn();
    const observer = new CodexProjectObserver({ instances: [f.instance], projectScope: f.projectScope, importService: { runChanged, clearChangeCache } });
    const first = observer.tick(); const second = observer.tick();
    expect(first).toBe(second);
    const settled = Promise.allSettled([first, second]);
    await entered; await observer.stop(); await settled;
    expect(runChanged).toHaveBeenCalledTimes(1);
    expect(observer.snapshot().state).toBe("stopped");
  });

  it("does not restart when stop supersedes a start waiting for an active pass", async () => {
    const f = await fixture();
    let release!: () => void; let began!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { began = resolve; });
    const runChanged = vi.fn(async () => { began(); await gate; return null; });
    const observer = new CodexProjectObserver({ instances: [f.instance], projectScope: f.projectScope, importService: { runChanged, clearChangeCache: vi.fn() }, intervalMs: 250 });
    const tick = observer.tick().catch(() => undefined); await entered;
    vi.useFakeTimers();
    try {
      const start = observer.start(); const stop = observer.stop(); release();
      await Promise.all([tick, start, stop]);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(runChanged).toHaveBeenCalledTimes(1);
      expect(observer.snapshot().state).toBe("stopped");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); await observer.stop(); }
  });
});
