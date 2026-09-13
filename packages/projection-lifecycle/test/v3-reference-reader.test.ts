import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CanonicalChangePage, CanonicalChangeQuery, CanonicalChangeV1, CanonicalProjectionInput,
  CanonicalProjectionSessionInput, IncrementalCanonicalProjectionSource, OperationId,
  ProjectionOperationReceipt, ProjectionRun, ProjectionRunRepository, ProjectionRunState,
  ProjectionSession, RunId,
} from "@linmu/dsh-session-contracts";
import { MemoryStatusEventAdapter, StatusLog } from "@linmu/dsh-session-status-log";
import { adapter, v3NativeSessionId } from "../../adapter-dsh-0-1-5/src/index.js";
import { JsonProjectionDirectory, PersistentProjectionCache, ProjectionLifecycle } from "../src/index.js";
import { readProjectionRecoveryDescriptor } from "../src/recovery.js";

const at = "2026-09-13T00:00:00.000Z";
const roots: string[] = [];
const temporaryParent = resolve(tmpdir());
async function fixtureRoot() {
  const root = await mkdtemp(join(temporaryParent, "dsh-sm-v3-reader-fixture-"));
  await writeFile(join(root, "SYNTHETIC-FIXTURE.json"), '{"userData":false}\n');
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const child = relative(temporaryParent, resolve(root));
    if (isAbsolute(child) || !child.startsWith("dsh-sm-v3-reader-fixture-") || child.includes("..")) throw new Error("Invalid fixture cleanup target");
    await rm(root, { recursive: true, force: true });
  }
});

function item(id = "logical-reader", title = "Synthetic fixture"): CanonicalProjectionSessionInput {
  return { session: { schemaVersion: 1, id: id as never, authorityScope: "maintenance", originKind: "maintenance-native",
    headVersionId: null, title, tags: [], archivedAt: null, tombstonedAt: null, createdAt: at, updatedAt: at },
  events: [], workspaceId: null, projectId: null, projectName: null, projectRoot: null };
}
function run(id: string, instanceId = "v3-instance", profileId = "web"): ProjectionRun {
  return { schemaVersion: 1, id: id as never, leaseId: `lease-${id}` as never, branchId: "main" as never,
    instanceId, profileId, dshVersion: "0.1.5-rc.2", adapterId: adapter.manifest.id, state: "preparing",
    startedAt: at, heartbeatAt: at, checkpointId: null };
}
function statusLog() {
  let sequence = 0;
  return new StatusLog(new MemoryStatusEventAdapter(), { clock: () => at, idFactory: kind => `${kind}-${++sequence}` });
}
class Runs implements ProjectionRunRepository {
  readonly runs = new Map<string, ProjectionRun>();
  readonly sessions = new Map<string, ProjectionSession>();
  async createProjectionRun(value: ProjectionRun) { this.runs.set(value.id, value); return value; }
  async getProjectionRun(id: RunId) { return this.runs.get(id); }
  async setProjectionRunState(id: RunId, state: ProjectionRunState) { this.runs.set(id, { ...this.runs.get(id)!, state }); }
  async setProjectionRunCheckpoint(id: RunId, checkpointId: string) { this.runs.set(id, { ...this.runs.get(id)!, checkpointId }); }
  async upsertProjectionSession(value: ProjectionSession) { this.sessions.set(`${value.runId}:${value.nativeSessionId}`, value); }
  async listProjectionSessions(id: RunId) { return [...this.sessions.values()].filter(value => value.runId === id); }
  async saveOperationReceipt(_value: ProjectionOperationReceipt) {}
  async getOperationReceipt(_id: OperationId) { return undefined; }
}
class Source implements IncrementalCanonicalProjectionSource {
  revision = 1;
  fullLoads = 0;
  items = [item()];
  changes: CanonicalChangeV1[] = [{ schemaVersion: 1, revision: 1, logicalSessionId: "logical-reader" as never, kind: "session-created", changedAt: at }];
  async currentRevision() { return this.revision; }
  async load(current: ProjectionRun) { this.fullLoads++; return { run: current, workspaces: [], sessions: this.items }; }
  async loadSessions(current: ProjectionRun, ids: readonly string[]) { return { run: current, workspaces: [], sessions: this.items.filter(value => ids.includes(value.session.id)) }; }
  async listChanges(query: CanonicalChangeQuery): Promise<CanonicalChangePage> {
    const changes = this.changes.filter(value => value.revision > query.afterRevision).slice(0, query.limit);
    const throughRevision = changes.at(-1)?.revision ?? query.afterRevision;
    return { schemaVersion: 1, afterRevision: query.afterRevision, throughRevision, currentRevision: this.revision, hasMore: throughRevision < this.revision, changes };
  }
}
function lifecycle(root: string, source: { load(current: ProjectionRun): Promise<CanonicalProjectionInput> }, runs = new Runs()) {
  let sequence = 0;
  return new ProjectionLifecycle({ runtimeRoot: root, source, adapter, runRepository: runs, statusLog: statusLog(),
    bridge: { attach: async () => { throw new Error("No runtime is started by this fixture"); }, drain: async () => { throw new Error("No runtime exists"); }, detach: async () => undefined },
    checkpointRepository: { saveCheckpoint: async () => undefined }, clock: () => at, idFactory: kind => `${kind}-${++sequence}` });
}
const prepareInput = (instanceId = "v3-instance", profileId = "web") => ({ instanceId, profileId, dshVersion: "0.1.5-rc.2",
  branchId: "main" as never, maintenanceEndpoint: "http://127.0.0.1:1" });
const reference = { logicalSessionId: "logical-reader" as never, logicalAnchorId: null, legacyNativeSessionId: null };

describe("V3 projection identity requires the materialized reader", () => {
  it("prepares a non-cache lifecycle with the actual strict V3 resolver", async () => {
    const root = await fixtureRoot(), runs = new Runs();
    const source = { load: async (current: ProjectionRun) => ({ run: current, workspaces: [], sessions: [item()] }) };
    const owner = lifecycle(root, source, runs);
    const prepared = await owner.prepareRun(prepareInput());
    const reader = new JsonProjectionDirectory(prepared.projectionRoot);
    expect(await adapter.resolveReference(reference, prepared.run)).toMatchObject({ status: "unavailable" });
    expect(await adapter.resolveReference(reference, prepared.run, reader)).toMatchObject({ status: "resolved", nativeSessionId: v3NativeSessionId(reference.logicalSessionId) });
    expect(await runs.listProjectionSessions(prepared.run.id)).toMatchObject([{ logicalSessionId: reference.logicalSessionId, nativeSessionId: v3NativeSessionId(reference.logicalSessionId) }]);
    await owner.discardPreparedRun(prepared.run.id);
  });

  it("resolves identities only after baseline and delta payloads exist", async () => {
    const root = await fixtureRoot(), source = new Source();
    const cache = new PersistentProjectionCache({ runtimeRoot: root, source, adapter, statusLog: statusLog(), clock: () => at });
    const configuration = { branchId: "main", instanceId: "v3-instance", profileId: "web" };
    const first = await cache.apply({ run: run("baseline"), configuration });
    expect(first.receipt).toMatchObject({ baseline: true, rewrittenSessions: 1 });
    const reader = new JsonProjectionDirectory(first.cacheRoot);
    expect(await adapter.resolveReference(reference, run("baseline"), reader)).toMatchObject({ status: "resolved" });
    source.revision = 3;
    source.items = [item("logical-reader", "Updated fixture"), item("logical-new", "Added fixture")];
    source.changes.push({ schemaVersion: 1, revision: 2, logicalSessionId: "logical-reader" as never, kind: "metadata-updated", changedAt: at },
      { schemaVersion: 1, revision: 3, logicalSessionId: "logical-new" as never, kind: "session-created", changedAt: at });
    const delta = await cache.apply({ run: run("delta"), configuration });
    expect(delta.receipt).toMatchObject({ baseline: false, rewrittenSessions: 2 });
    expect(await reader.readSession(v3NativeSessionId(reference.logicalSessionId))).toMatchObject({ title: "Updated fixture", instanceId: "v3-instance", profileId: "web" });
    expect(await adapter.resolveReference({ ...reference, logicalSessionId: "logical-new" as never }, run("delta"), reader)).toMatchObject({ status: "resolved" });
    expect(await adapter.resolveReference(reference, run("wrong-scope", "other-instance"), reader)).toMatchObject({ status: "unavailable" });
  });

  it("retains caches per instance and profile while reusing the same scope across runs", async () => {
    const root = await fixtureRoot(), source = new Source(), owner = lifecycle(root, source);
    const nativeId = v3NativeSessionId(reference.logicalSessionId);
    const cacheRoots: string[] = [];
    for (const [instanceId, profileId] of [["instance-a", "web"], ["instance-b", "web"], ["instance-a", "analysis"], ["instance-a", "web"]]) {
      const prepared = await owner.prepareRun(prepareInput(instanceId, profileId));
      const reader = new JsonProjectionDirectory(prepared.projectionRoot);
      expect(await reader.readSession(nativeId)).toMatchObject({ instanceId, profileId });
      expect(await adapter.resolveReference(reference, prepared.run, reader)).toMatchObject({ status: "resolved" });
      const descriptor = await readProjectionRecoveryDescriptor(prepared.projectionRoot);
      expect(descriptor.baseProjectionRoot).toBeTypeOf("string");
      cacheRoots.push(descriptor.baseProjectionRoot!);
      await owner.discardPreparedRun(prepared.run.id);
    }
    expect(new Set(cacheRoots.slice(0, 3)).size).toBe(3);
    expect(cacheRoots[3]).toBe(cacheRoots[0]);
    expect(source.fullLoads).toBe(3);
  });
});
