import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexReadAdapter } from "../../packages/adapter-codex-read/src/index.js";
import { CodexNativeWriteAdapter } from "../../packages/adapter-codex-native/src/index.js";
import { WriteService } from "../../apps/engine/src/write-service.js";
import type { NormalizedEvent, NormalizedSession, RegisteredInstance } from "../../packages/contracts/src/index.js";
import { NativeMirrorService } from "../../packages/native-mirror-engine/src/index.js";
import { canonicalJson, createSyncPlan } from "../../packages/session-domain/src/index.js";
import {
  SqliteSessionRepository,
  ZstdContentObjectStore,
  openMaintenanceDatabase,
} from "../../packages/session-store/src/index.js";
import {
  assertFixtureSandbox,
  createFixtureSandbox,
  writeCodexFixtureHome,
} from "../../packages/test-support/src/index.js";
import { TransactionExecutor } from "../../packages/transaction-engine/src/index.js";

const cleanups: Array<() => Promise<void>> = [];
const repositories: SqliteSessionRepository[] = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Codex native mirror transaction", () => {
  it("commits an enabled DSH fast-forward, verifies it through the normal reader, and converges both refs", async () => {
    const sandbox = await createFixtureSandbox("codex-native-mirror");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);

    const stateRoot = join(sandbox.root, "maintenance-state");
    const objectStore = new ZstdContentObjectStore(stateRoot);
    const repository = new SqliteSessionRepository(
      openMaintenanceDatabase(join(stateRoot, "metadata.sqlite")),
      objectStore,
    );
    repositories.push(repository);

    const codexInstance: RegisteredInstance = {
      id: "codex-fixture",
      platform: "codex",
      displayName: "Codex fixture",
      root: sandbox.codexHome,
      platformVersion: "0.146.0",
    };
    const codexKey = {
      platform: "codex" as const,
      instanceId: codexInstance.id,
      sessionId: "thread-fixture",
    };
    const codexReader = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });
    const readProbe = await codexReader.probe(codexInstance);
    expect(readProbe.status).toBe("compatible");
    const firstObservation = await codexReader.observe(codexInstance, codexKey);
    if (firstObservation.kind !== "stable") throw new Error(firstObservation.reason);
    const target = await codexReader.normalize(firstObservation);

    const dshKey = { platform: "dsh" as const, instanceId: "dsh-fixture", sessionId: "dsh-source" };
    const appended: NormalizedEvent = {
      id: "dsh-import-tool-record",
      parentId: target.events.at(-1)?.id ?? null,
      sequence: target.events.length,
      kind: "tool-import",
      role: "tool",
      content: "fixture tool record",
      attachments: [],
      source: { ...dshKey, eventId: "dsh-tool-1", sequence: target.events.length },
      extensions: { tool: "fixture" },
    };
    const source: NormalizedSession = {
      ...target,
      key: dshKey,
      title: "Mirrored fixture",
      events: [...target.events, appended],
      bodyHash: "body-dsh-source",
      metadataHash: "metadata-dsh-source",
      provenance: { ...dshKey, observedAt: "2026-08-27T00:00:00.000Z", sourceVersion: "0.1.1-rc.2" },
    };

    const logicalSessionId = "logical-native-mirror";
    await repository.createLogicalSession({
      id: logicalSessionId,
      displayTitle: target.title,
      canonicalVersionId: null,
      syncMode: "continuation",
      archived: false,
      labels: [],
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    const targetVersion = await repository.putVersion({
      logicalSessionId,
      parents: [],
      bodyObject: await objectStore.put(Buffer.from(canonicalJson(target as never))),
      bodyHash: target.bodyHash,
      metadataHash: target.metadataHash,
      source: target.provenance,
      compatibility: target.compatibility,
    });
    const sourceVersion = await repository.putVersion({
      logicalSessionId,
      parents: [targetVersion.id],
      bodyObject: await objectStore.put(Buffer.from(canonicalJson(source as never))),
      bodyHash: source.bodyHash,
      metadataHash: source.metadataHash,
      source: source.provenance,
      compatibility: source.compatibility,
    });
    const codexBindingId = "binding-codex";
    const dshBindingId = "binding-dsh";
    const dshContract = { adapter: "dsh-read-fixture", platformVersion: "0.1.1-rc.2", schemaFingerprint: "fixture" };
    await repository.bindPlatformSession({ id: codexBindingId, logicalSessionId, key: codexKey, adapterContract: readProbe.contract, lastCommonVersionId: targetVersion.id, status: "writable" });
    await repository.bindPlatformSession({ id: dshBindingId, logicalSessionId, key: dshKey, adapterContract: dshContract, lastCommonVersionId: targetVersion.id, status: "writable" });
    await repository.recordObservation({ bindingId: codexBindingId, versionId: targetVersion.id, observedAt: target.provenance.observedAt, fingerprint: firstObservation.fingerprint });
    const sourceFingerprint = { ...dshKey, kind: "content" as const, value: "dsh-source-before" };
    await repository.recordObservation({ bindingId: dshBindingId, versionId: sourceVersion.id, observedAt: source.provenance.observedAt, fingerprint: sourceFingerprint });

    const mirrors = new NativeMirrorService({ repository, clock: () => "2026-08-27T00:00:01.000Z" });
    expect((await mirrors.apply(logicalSessionId, { action: "enable" })).state).toBe("active");
    await mirrors.requireWritable(logicalSessionId);

    const writer = new CodexNativeWriteAdapter({
      stateRoot,
      loadSource: async () => source,
      fixtureGuard: assertFixtureSandbox,
      quietDelayMs: 1,
      registeredRoots: new Map([[codexInstance.id, codexInstance.root]]),
      now: () => new Date("2026-08-27T00:00:02.000Z"),
    });
    const writeProbe = await writer.probeWrite(codexInstance);
    expect(writeProbe.status).toBe("compatible");
    const plan = createSyncPlan({
      createdAt: "2026-08-27T00:00:02.000Z",
      logicalSessionId,
      baseVersionId: targetVersion.id,
      base: { events: target.events, metadata: { title: target.title, archived: target.archived } },
      source: {
        snapshot: { bindingId: dshBindingId, key: dshKey, versionId: sourceVersion.id, fingerprints: [sourceFingerprint] },
        events: source.events,
        metadata: { title: source.title, archived: source.archived },
      },
      target: {
        kind: "present",
        head: {
          snapshot: { bindingId: codexBindingId, key: codexKey, versionId: targetVersion.id, fingerprints: [firstObservation.fingerprint] },
          events: target.events,
          metadata: { title: target.title, archived: target.archived },
        },
      },
      adapterContracts: [dshContract, readProbe.contract, writeProbe.contract],
    });
    await repository.savePlan(plan);
    expect(plan.operations).toEqual([
      { type: "append-events", fromIndex: target.events.length, eventIds: [appended.id] },
      { type: "update-title", title: source.title },
    ]);

    const instances = new Map([[codexInstance.id, codexInstance]]);
    const executor = new TransactionExecutor({
      stateRoot,
      repository,
      adapters: new Map([["codex", writer]]),
      instances,
      readFingerprints: async () => plan.preconditions,
      now: () => new Date("2026-08-27T00:00:02.000Z"),
      idFactory: () => "tx-native-mirror",
    });
    const writeService = new WriteService({
      repository,
      objectStore,
      executor,
      instances,
      readers: new Map([["codex", codexReader]]),
    });
    const result = await writeService.applyPlan({ planId: plan.id });
    expect(result).toEqual({ id: "tx-native-mirror", status: "completed" });
    const mirror = await mirrors.recordCompletedTransaction(logicalSessionId, result.id);
    expect(mirror).toMatchObject({ state: "active", lastTransactionId: result.id });
    expect(await repository.getTransaction(result.id)).toMatchObject({ platform: "codex", status: "completed" });
    expect((await repository.getObservedHead(codexBindingId))?.versionId).toBe(mirror.commonVersionId);
    expect((await repository.getObservedHead(dshBindingId))?.versionId).toBe(mirror.commonVersionId);
  });
});
