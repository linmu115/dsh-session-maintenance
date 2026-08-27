import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DshWriteAdapter } from "../../packages/adapter-dsh-write/src/index.js";
import {
  LockedRc2CoreExtension,
  RC2_CORE_CONTRACT_FINGERPRINT,
} from "../../packages/dsh-core-extension/src/index.js";
import { DshGatewayTokenService, DshHostGateway } from "../../packages/dsh-host-gateway/src/index.js";
import { WriteService } from "../../apps/engine/src/write-service.js";
import {
  type AdapterProbe,
  type ExpectedPlatformState,
  type NormalizedSession,
  type PlatformSessionKey,
  type RegisteredInstance,
  type SessionReadAdapter,
  type StableObservation,
} from "../../packages/contracts/src/index.js";
import { createSyncPlan, normalizeSession } from "../../packages/session-domain/src/index.js";
import {
  SqliteSessionRepository,
  ZstdContentObjectStore,
  openMaintenanceDatabase,
} from "../../packages/session-store/src/index.js";
import { createDshCoreFixtureHost } from "../../packages/test-support/src/index.js";
import { TransactionExecutor } from "../../packages/transaction-engine/src/index.js";

const roots: string[] = [];
const repositories: SqliteSessionRepository[] = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function rawEvent(
  id: string,
  sequence: number,
  role: "user" | "assistant",
  content: string,
) {
  return {
    sourceEventId: id,
    parentSourceEventId: null,
    sequence,
    kind: "message" as const,
    role,
    content,
    attachments: [],
    extensions: {},
  };
}

class FixtureDshReader implements SessionReadAdapter {
  readonly platform = "dsh" as const;
  readonly target: NormalizedSession;
  readonly stateDigest: () => string;

  constructor(target: NormalizedSession, stateDigest: () => string) {
    this.target = target;
    this.stateDigest = stateDigest;
  }

  probe(_instance: RegisteredInstance): Promise<AdapterProbe> {
    return Promise.resolve({
      status: "compatible",
      contract: {
        adapter: "dsh-read-fixture",
        platformVersion: "0.1.1-rc.2",
        schemaFingerprint: "fixture-read-v1",
      },
      capabilities: ["list", "observe", "normalize", "verify-read"],
      issues: [],
    });
  }

  async *list() { yield { key: this.target.key, title: this.target.title, archived: this.target.archived, workspaceId: null, updatedAt: this.target.provenance.observedAt, hint: {} }; }

  observe(_instance: RegisteredInstance, key: PlatformSessionKey): Promise<StableObservation> {
    return Promise.resolve({
      kind: "stable",
      key,
      fingerprint: { ...key, kind: "content", value: this.stateDigest() },
      payload: this.target,
    });
  }

  normalize(observation: StableObservation): Promise<NormalizedSession> {
    return Promise.resolve(observation.payload as NormalizedSession);
  }

  async verify(instance: RegisteredInstance, key: PlatformSessionKey, expected: ExpectedPlatformState) {
    const observed = await this.observe(instance, key);
    const ok = expected.fingerprints.length === 1 && expected.fingerprints[0]?.value === observed.fingerprint.value;
    return { ok, fingerprints: [observed.fingerprint], issues: ok ? [] : [{ code: "PLAN_STALE", message: "fixture changed" }] };
  }
}

describe("verified DSH fast-forward", () => {
  it("advances refs once and preserves divergent branches without host writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-p16-"));
    roots.push(root);
    const store = new ZstdContentObjectStore(root);
    const repository = new SqliteSessionRepository(openMaintenanceDatabase(join(root, "metadata.sqlite")), store);
    repositories.push(repository);
    const logicalSessionId = "logical-p16";
    await repository.createLogicalSession({
      id: logicalSessionId,
      displayTitle: "Fixture conversation",
      canonicalVersionId: null,
      syncMode: "paused",
      archived: false,
      labels: [],
      createdAt: "2026-08-27T00:00:00.000Z",
    });

    const sourceKey = { platform: "codex" as const, instanceId: "codex-fixture", sessionId: "codex-p16" };
    const targetKey = { platform: "dsh" as const, instanceId: "dsh-fixture", sessionId: "dsh-session-1" };
    const baseEvents = [rawEvent("u0", 0, "user", "hello"), rawEvent("a0", 1, "assistant", "response")];
    const fullEvents = [...baseEvents, rawEvent("u1", 2, "user", "new prompt"), rawEvent("a1", 3, "assistant", "new response")];
    const base = normalizeSession({
      key: targetKey,
      title: "Fixture conversation",
      archived: false,
      workspaceId: null,
      provenance: { ...targetKey, observedAt: "2026-08-27T00:00:00.000Z", sourceVersion: "0.1.1-rc.2" },
      compatibility: { status: "compatible", issues: [] },
      events: baseEvents,
    });
    const source = normalizeSession({
      key: sourceKey,
      title: "Imported session",
      archived: true,
      workspaceId: null,
      provenance: { ...sourceKey, observedAt: "2026-08-27T00:00:01.000Z", sourceVersion: "0.146.0" },
      compatibility: { status: "compatible", issues: [] },
      events: fullEvents,
    });
    const observedTarget = normalizeSession({
      key: targetKey,
      title: source.title,
      archived: source.archived,
      workspaceId: null,
      provenance: { ...targetKey, observedAt: "2026-08-27T00:00:02.000Z", sourceVersion: "0.1.1-rc.2" },
      compatibility: { status: "compatible", issues: [] },
      events: fullEvents,
    });
    const baseManifest = await repository.putVersion({
      logicalSessionId,
      parents: [],
      bodyObject: await store.put(Buffer.from(JSON.stringify(base))),
      bodyHash: base.bodyHash,
      metadataHash: base.metadataHash,
      source: base.provenance,
      compatibility: base.compatibility,
    });
    const sourceManifest = await repository.putVersion({
      logicalSessionId,
      parents: [baseManifest.id],
      bodyObject: await store.put(Buffer.from(JSON.stringify(source))),
      bodyHash: source.bodyHash,
      metadataHash: source.metadataHash,
      source: source.provenance,
      compatibility: source.compatibility,
    });
    const codexContract = { adapter: "codex-read-fixture", platformVersion: "0.146.0", schemaFingerprint: "fixture-codex-v1" };
    const dshContract = { adapter: "dsh-read-fixture", platformVersion: "0.1.1-rc.2", schemaFingerprint: "fixture-read-v1" };
    await repository.bindPlatformSession({ id: "binding-codex", logicalSessionId, key: sourceKey, adapterContract: codexContract, lastCommonVersionId: baseManifest.id, status: "read-only" });
    await repository.bindPlatformSession({ id: "binding-dsh", logicalSessionId, key: targetKey, adapterContract: dshContract, lastCommonVersionId: baseManifest.id, status: "writable" });
    await repository.recordObservation({ bindingId: "binding-codex", versionId: sourceManifest.id, observedAt: source.provenance.observedAt, fingerprint: { ...sourceKey, kind: "content", value: "source-before" } });
    await repository.recordObservation({ bindingId: "binding-dsh", versionId: baseManifest.id, observedAt: base.provenance.observedAt, fingerprint: { ...targetKey, kind: "content", value: "target-before" } });

    const plan = createSyncPlan({
      createdAt: "2026-08-27T00:00:03.000Z",
      logicalSessionId,
      baseVersionId: baseManifest.id,
      base: { events: source.events.slice(0, 2), metadata: { title: base.title, archived: base.archived } },
      source: { snapshot: { bindingId: "binding-codex", key: sourceKey, versionId: sourceManifest.id, fingerprints: [{ ...sourceKey, kind: "content", value: "source-before" }] }, events: source.events, metadata: { title: source.title, archived: source.archived } },
      target: { kind: "present", head: { snapshot: { bindingId: "binding-dsh", key: targetKey, versionId: baseManifest.id, fingerprints: [{ ...targetKey, kind: "content", value: "target-before" }] }, events: source.events.slice(0, 2), metadata: { title: base.title, archived: base.archived } } },
      adapterContracts: [codexContract, dshContract, { adapter: "dsh-write-core", platformVersion: "0.1.1-rc.2", schemaFingerprint: RC2_CORE_CONTRACT_FINGERPRINT }],
    });
    await repository.savePlan(plan);
    expect({ risk: plan.risk, operations: plan.operations, confirmations: plan.confirmations }).toEqual({
      risk: "safe",
      operations: [
        expect.objectContaining({ type: "append-events" }),
        { type: "update-title", title: source.title },
        { type: "update-archive", archived: true },
      ],
      confirmations: [],
    });

    const host = createDshCoreFixtureHost();
    const gateway = new DshHostGateway({
      extensions: new Map([["dsh-fixture", new LockedRc2CoreExtension(host)]]),
      tokens: new DshGatewayTokenService({ secret: Buffer.alloc(32, 8), now: () => new Date("2026-08-27T00:00:03.000Z") }),
      materializationProbe: async () => ({ status: "compatible", sourceHash: "sha256:fixture-source", artifactHash: "sha256:fixture-artifact", issues: [] }),
    });
    const writer = new DshWriteAdapter({ stateRoot: root, gateway, loadSource: async () => source, now: () => new Date("2026-08-27T00:00:03.000Z") });
    const instance = { id: "dsh-fixture", platform: "dsh" as const, displayName: "fixture", root: join(root, "marked-synthetic-dsh-home"), platformVersion: "0.1.1-rc.2" };
    const executor = new TransactionExecutor({ stateRoot: root, repository, adapters: new Map([["dsh", writer]]), instances: new Map([[instance.id, instance]]), readFingerprints: async () => plan.preconditions, now: () => new Date("2026-08-27T00:00:03.000Z"), idFactory: () => "tx-p16" });
    const reader = new FixtureDshReader(observedTarget, () => JSON.stringify(host.domainDigests(targetKey.sessionId)));
    const service = new WriteService({ repository, objectStore: store, executor, instances: new Map([[instance.id, instance]]), dshReader: reader });

    const first = await service.applyPlan({ planId: plan.id });
    const writesAfterFirst = [...host.writes];
    expect(first).toEqual({ id: "tx-p16", status: "completed" });
    expect(await service.applyPlan({ planId: plan.id })).toEqual(first);
    expect(host.writes).toEqual(writesAfterFirst);

    const graph = await repository.getGraphPage(logicalSessionId);
    const canonical = graph.refs.find((ref) => ref.name === "canonical")?.versionId;
    expect(canonical).toBeDefined();
    expect((await repository.getObservedHead("binding-dsh"))?.versionId).toBe(canonical);
    expect((await repository.listBindings(logicalSessionId)).map((binding) => binding.lastCommonVersionId)).toEqual([canonical, canonical]);

    const divergent = createSyncPlan({
      createdAt: "2026-08-27T00:00:04.000Z",
      logicalSessionId,
      baseVersionId: baseManifest.id,
      base: { events: base.events, metadata: { title: base.title, archived: base.archived } },
      source: { snapshot: { bindingId: "binding-codex", key: sourceKey, versionId: sourceManifest.id, fingerprints: [{ ...sourceKey, kind: "content", value: "source-before" }] }, events: [...base.events, source.events[2]!], metadata: { title: base.title, archived: base.archived } },
      target: { kind: "present", head: { snapshot: { bindingId: "binding-dsh", key: targetKey, versionId: baseManifest.id, fingerprints: [{ ...targetKey, kind: "content", value: "target-before" }] }, events: [...base.events, { ...source.events[2]!, id: "different", content: "other branch" }], metadata: { title: base.title, archived: base.archived } } },
      adapterContracts: [codexContract, dshContract],
    });
    await repository.savePlan(divergent);
    await expect(service.applyPlan({ planId: divergent.id })).rejects.toMatchObject({ code: "WRITE_CAPABILITY_UNAVAILABLE" });
    expect(host.writes).toEqual(writesAfterFirst);
  });
});
