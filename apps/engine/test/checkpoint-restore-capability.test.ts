import { afterEach, describe, expect, it, vi } from "vitest";
import type { Checkpoint, NormalizedSession, PlatformBinding, SessionVersionManifest } from "@linmu/dsh-session-contracts";
import { normalizeSession, normalizedSessionHashes, sha256Canonical } from "@linmu/dsh-session-domain";
import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { checkpointRestoreCapability, loadCheckpointRestoreSource } from "../src/checkpoint-restore-source.js";
import { createDshWritableComposition, probeAndAddInstance } from "../src/composition-root.js";
import { startMaintenanceServer } from "../src/http/server.js";
import { createEngineFixture, createFixtureSystem, hashTree } from "./helpers.js";

const at = "2026-09-06T00:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sourceFixture(overrides: { title?: string; content?: string } = {}) {
  const key = { platform: "codex" as const, instanceId: "fixture-instance", sessionId: "fixture-session" };
  const source = normalizeSession({ key, title: overrides.title ?? "合成会话", archived: false, workspaceId: null,
    provenance: { ...key, observedAt: at }, compatibility: { status: "compatible", issues: [] }, events: [{
      sourceEventId: "event-fixture", parentSourceEventId: null, sequence: 0, kind: "message", role: "user",
      content: overrides.content ?? "合成正文", attachments: [], extensions: {},
    }] });
  const version: SessionVersionManifest = { schemaVersion: 1, id: "version-fixture", logicalSessionId: "logical-fixture",
    parents: [], bodyObject: "object-fixture", bodyHash: source.bodyHash, metadataHash: source.metadataHash,
    source: source.provenance, compatibility: source.compatibility };
  const binding: PlatformBinding = { id: "binding-fixture", logicalSessionId: version.logicalSessionId, key,
    adapterContract: { adapter: "fixture-read", platformVersion: "fixture", schemaFingerprint: "fixture" },
    lastCommonVersionId: null, status: "read-only" };
  const checkpoint: Checkpoint = { id: "checkpoint-fixture", name: "合成恢复点", description: "仅合成数据",
    refs: { [`session:${version.logicalSessionId}`]: version.id }, backupTransactionIds: [], createdBy: "test", createdAt: at };
  const repository = {
    getCheckpoint: vi.fn(async (): Promise<Checkpoint | undefined> => checkpoint),
    getVersion: vi.fn(async (): Promise<SessionVersionManifest | undefined> => version),
    findBinding: vi.fn(async (): Promise<PlatformBinding | undefined> => binding),
  };
  const objectStore = { get: vi.fn(async () => Buffer.from(JSON.stringify(source))) };
  return { source, version, binding, checkpoint, repository, objectStore,
    query: () => checkpointRestoreCapability(repository, objectStore, checkpoint.id),
    load: () => loadCheckpointRestoreSource(repository, objectStore, checkpoint.id) };
}

describe("checkpoint restore source capability", () => {
  it.each([
    { name: "session ref", refs: { "session:logical-fixture": "version-fixture" } },
    { name: "legacy single ref", refs: { canonical: "version-fixture" } },
    { name: "one session ref plus unrelated ref", refs: { "session:logical-fixture": "version-fixture", other: "ignored-version" } },
  ])("accepts $name without a target probe or plan creation", async ({ refs }) => {
    const fixture = sourceFixture();
    fixture.repository.getCheckpoint.mockResolvedValue({ ...fixture.checkpoint, refs });
    expect(await fixture.query()).toMatchObject({ checkpointId: fixture.checkpoint.id, supported: true, reason: expect.stringContaining("目标是否可写") });
    expect(await fixture.load()).toMatchObject({ version: fixture.version, source: fixture.source, binding: fixture.binding });
    expect(fixture.repository.getVersion).toHaveBeenCalledWith("version-fixture");
  });

  it.each([{}, { first: "version-fixture", second: "version-fixture" },
    { "session:logical-fixture": "version-fixture", "session:other": "version-fixture" }])("rejects ambiguous refs %j in both query and planner loader", async (refs) => {
    const fixture = sourceFixture();
    fixture.repository.getCheckpoint.mockResolvedValue({ ...fixture.checkpoint, refs });
    expect(await fixture.query()).toMatchObject({ supported: false, reason: expect.stringContaining("唯一") });
    await expect(fixture.load()).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" });
    expect(fixture.objectStore.get).not.toHaveBeenCalled();
  });

  it("rejects missing checkpoints, versions and inconsistent session refs", async () => {
    const fixture = sourceFixture();
    fixture.repository.getCheckpoint.mockResolvedValueOnce(undefined);
    expect(await fixture.query()).toMatchObject({ supported: false, reason: expect.stringContaining("不存在") });
    fixture.repository.getVersion.mockResolvedValueOnce(undefined);
    expect(await fixture.query()).toMatchObject({ supported: false, reason: expect.stringContaining("版本缺失") });
    fixture.repository.getVersion.mockResolvedValueOnce({ ...fixture.version, id: "different-version" });
    expect((await fixture.query()).supported).toBe(false);
    fixture.repository.getCheckpoint.mockResolvedValue({ ...fixture.checkpoint, refs: { "session:wrong-session": fixture.version.id } });
    expect(await fixture.query()).toMatchObject({ supported: false, reason: expect.stringContaining("会话引用") });
  });

  it("gives Canonical objects an explicit unsupported reason even without a legacy binding", async () => {
    const fixture = sourceFixture();
    fixture.objectStore.get.mockResolvedValue(Buffer.from(JSON.stringify({ schemaVersion: 1, workspaceId: null, events: [] })));
    fixture.repository.findBinding.mockResolvedValue(undefined);
    expect(await fixture.query()).toMatchObject({ supported: false, reason: expect.stringContaining("Canonical") });
    await expect(fixture.load()).rejects.toMatchObject({ code: "CAPABILITY_NOT_AVAILABLE" });
  });

  it("does not trust a normalized-shaped object labelled as a Canonical source", async () => {
    const fixture = sourceFixture();
    fixture.repository.getVersion.mockResolvedValue({ ...fixture.version, source: { ...fixture.version.source, instanceId: "canonical-projection" } });
    expect(await fixture.query()).toMatchObject({ supported: false, reason: expect.stringContaining("Canonical") });
  });

  it("rejects missing, malformed and schema-invalid body objects without exposing storage paths", async () => {
    const fixture = sourceFixture();
    fixture.objectStore.get.mockRejectedValueOnce(new Error("private-fixture-path/object-missing"));
    const missing = await fixture.query();
    expect(missing).toMatchObject({ supported: false, reason: expect.stringContaining("内容缺失") });
    expect(missing.reason).not.toContain("private-fixture-path");
    for (const content of ["not JSON", "{}", JSON.stringify({ ...fixture.source, events: [{ content: "bad event" }] })]) {
      fixture.objectStore.get.mockResolvedValueOnce(Buffer.from(content));
      expect((await fixture.query()).supported).toBe(false);
    }
  });

  it("rejects missing or inconsistent bindings and source identities", async () => {
    const fixture = sourceFixture();
    fixture.repository.findBinding.mockResolvedValueOnce(undefined);
    expect((await fixture.query()).supported).toBe(false);
    fixture.repository.findBinding.mockResolvedValueOnce({ ...fixture.binding, logicalSessionId: "other-logical-session" });
    expect((await fixture.query()).supported).toBe(false);
    fixture.repository.findBinding.mockResolvedValueOnce({ ...fixture.binding, key: { ...fixture.binding.key, sessionId: "other-native-session" } });
    expect((await fixture.query()).supported).toBe(false);
    fixture.objectStore.get.mockResolvedValueOnce(Buffer.from(JSON.stringify({ ...fixture.source, key: { ...fixture.source.key, sessionId: "other-body-session" } })));
    expect((await fixture.query()).supported).toBe(false);
  });

  it.each([{ content: "另一个有效正文" }, { title: "另一个有效标题" }])("rejects a different valid object with matching session identity %j", async (overrides) => {
    const fixture = sourceFixture();
    const swapped = sourceFixture(overrides).source;
    fixture.objectStore.get.mockResolvedValue(Buffer.from(JSON.stringify(swapped)));
    expect(await fixture.query()).toMatchObject({ supported: false, reason: expect.stringContaining("摘要") });
    await expect(fixture.load()).rejects.toMatchObject({ code: "OBJECT_CORRUPT" });
  });

  it.each(["body", "title", "archive", "workspace"])("recomputes %s semantics instead of trusting stale stored hashes", async (kind) => {
    const fixture = sourceFixture();
    const source = fixture.source;
    const tampered = kind === "body" ? { ...source, events: [{ ...source.events[0]!, content: "修改正文但保留旧摘要" }] }
      : kind === "title" ? { ...source, title: "修改标题但保留旧摘要" }
      : kind === "archive" ? { ...source, archived: true }
      : { ...source, workspaceId: "changed-workspace" };
    fixture.objectStore.get.mockResolvedValue(Buffer.from(JSON.stringify(tampered)));
    expect(await fixture.query()).toMatchObject({ supported: false, reason: expect.stringContaining("摘要") });
    await expect(fixture.load()).rejects.toMatchObject({ code: "OBJECT_CORRUPT" });
  });

  it("fails closed with a Chinese reason when repository reads fail", async () => {
    const fixture = sourceFixture();
    fixture.repository.getCheckpoint.mockRejectedValue(new Error("private database path"));
    expect(await fixture.query()).toEqual({ checkpointId: fixture.checkpoint.id, supported: false,
      reason: "无法读取并核对恢复点的源版本，当前不能生成恢复预览。" });
  });
});

describe("checkpoint capability Engine and authenticated API", () => {
  it("reports unsupported from a read-only Engine without querying source storage", async () => {
    const fixture = await createEngineFixture("checkpoint-capability-read-only");
    cleanups.push(fixture.cleanupAll);
    const read = vi.spyOn(fixture.engine.repository, "getCheckpoint");
    expect(await fixture.engine.getCheckpointRestoreCapability("checkpoint-fixture")).toMatchObject({ supported: false, reason: expect.stringContaining("未启用") });
    expect(read).not.toHaveBeenCalled();
    const server = await fixture.startServer();
    const client = new MaintenanceClient({ origin: server.origin, token: server.token });
    expect(await client.getCheckpointRestoreCapability("checkpoint-fixture")).toMatchObject({ checkpointId: "checkpoint-fixture", supported: false });
  });

  it("authenticates the GET query, validates its DTO, and never creates a plan or touches either home", async () => {
    const fixture = await createFixtureSystem("checkpoint-capability-writable-api");
    cleanups.push(fixture.cleanup);
    const options = { stateRoot: fixture.stateRoot, fixturePolicy: fixture.fixturePolicy };
    await probeAndAddInstance(options, { id: "codex-fixture", platform: "codex", displayName: "Codex fixture", root: fixture.codexHome, platformVersion: "0.146.0" });
    await probeAndAddInstance(options, { id: "dsh-fixture", platform: "dsh", displayName: "DSH fixture", root: fixture.dshHome, platformVersion: "0.1.1-rc.2" });
    // No gateway is running: source capability must not depend on target I/O.
    const engine = await createDshWritableComposition({ ...options,
      dshGatewayTargets: [{ instanceId: "dsh-fixture", origin: "http://127.0.0.1:1" }] });
    cleanups.push(async () => engine.close());
    await engine.scan({ instanceIds: ["codex-fixture"] });
    const session = (await engine.listSessions({ limit: 10 })).items[0]!;
    const version = (await engine.getGraph(session.logicalSessionId)).nodes[0]!;
    const checkpoint = await engine.createCheckpoint({ name: "旧版兼容合成恢复点", description: "仅合成数据",
      refs: { canonical: version.id }, backupTransactionIds: [], createdBy: "test", createdAt: at });
    const canonicalBody = { schemaVersion: 1, workspaceId: null, events: [] };
    const canonicalVersion = await engine.repository.putVersion({ logicalSessionId: session.logicalSessionId,
      parents: [version.id], bodyObject: await engine.objectStore.put(Buffer.from(JSON.stringify(canonicalBody))),
      bodyHash: sha256Canonical(canonicalBody), metadataHash: sha256Canonical({ title: "Canonical fixture", tags: [], archivedAt: null }),
      source: { platform: "dsh", instanceId: "canonical-projection", sessionId: session.logicalSessionId, observedAt: at },
      compatibility: { status: "compatible", issues: [] } });
    const canonicalCheckpointId = "canonical-protection-fixture";
    await engine.repository.saveCheckpoint({ ...checkpoint, id: canonicalCheckpointId,
      refs: { [`session:${session.logicalSessionId}`]: canonicalVersion.id } });
    const server = await startMaintenanceServer({ engine, stateRoot: fixture.stateRoot, skipAcl: true });
    cleanups.push(server.close);
    const client = new MaintenanceClient({ origin: server.origin, token: server.token });
    const before = await engine.repository.counts();
    const homes = [await hashTree(fixture.codexHome), await hashTree(fixture.dshHome)];
    const createPlan = vi.spyOn(engine, "createCheckpointRestorePlan");
    const savePlan = vi.spyOn(engine.repository, "savePlan");
    const response = await fetch(`${server.origin}/v1/checkpoints/${checkpoint.id}/restore-capability`);
    expect(response.status).toBe(401);
    expect(await client.getCheckpointRestoreCapability(checkpoint.id)).toMatchObject({ checkpointId: checkpoint.id, supported: true });
    expect(await client.getCheckpointRestoreCapability("missing-checkpoint")).toMatchObject({ supported: false });
    expect(await client.getCheckpointRestoreCapability(canonicalCheckpointId)).toMatchObject({ supported: false, reason: expect.stringContaining("Canonical") });
    expect(createPlan).not.toHaveBeenCalled();
    expect(savePlan).not.toHaveBeenCalled();
    await expect(client.createCheckpointRestorePlan({ checkpointId: canonicalCheckpointId,
      targetInstanceId: "dsh-fixture", createdAt: at })).rejects.toThrow("Canonical");
    // A manifest's version ID does not include bodyObject. Simulate a wrong
    // database pointer to a fully valid same-key object with different metadata.
    const originalSource = JSON.parse(Buffer.from(await engine.objectStore.get(version.bodyObject)).toString("utf8")) as NormalizedSession;
    const changedMetadata = { ...originalSource, title: "调换后的有效对象" };
    const wrongObject = await engine.objectStore.put(Buffer.from(JSON.stringify({
      ...changedMetadata, ...normalizedSessionHashes(changedMetadata),
    })));
    await engine.runWrite("fixture-wrong-checkpoint-object", async () => {
      engine.repository.database.prepare("UPDATE session_versions SET body_object = ?, manifest_json = ? WHERE id = ?")
        .run(wrongObject, JSON.stringify({ ...version, bodyObject: wrongObject }), version.id);
    });
    expect((await engine.repository.getVersion(version.id))?.id).toBe(version.id);
    expect(await client.getCheckpointRestoreCapability(checkpoint.id)).toMatchObject({ supported: false, reason: expect.stringContaining("摘要") });
    await expect(client.createCheckpointRestorePlan({ checkpointId: checkpoint.id,
      targetInstanceId: "dsh-fixture", createdAt: at })).rejects.toThrow("摘要");
    expect(savePlan).not.toHaveBeenCalled();
    expect(await engine.repository.counts()).toEqual(before);
    expect([await hashTree(fixture.codexHome), await hashTree(fixture.dshHome)]).toEqual(homes);
  });
});
