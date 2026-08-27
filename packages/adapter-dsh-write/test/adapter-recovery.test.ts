import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DshHostGateway,
  DshGatewayTokenService,
} from "@linmu/dsh-host-gateway";
import {
  LockedRc2CoreExtension,
  RC2_CORE_CONTRACT_FINGERPRINT,
} from "@linmu/dsh-core-extension";
import {
  SqliteSessionRepository,
  ZstdContentObjectStore,
  openMaintenanceDatabase,
} from "@linmu/dsh-session-store";
import { createSyncPlan, normalizeSession } from "@linmu/dsh-session-domain";
import { createDshCoreFixtureHost } from "@linmu/dsh-session-test-support";
import { TransactionExecutor } from "@linmu/dsh-session-transaction-engine";

import {
  DshWriteAdapter,
  PreparedDshWriteStore,
} from "../src/index.js";

const roots: string[] = [];
const repositories: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DshWriteAdapter recovery", () => {
  it("builds balanced native events and lets P14 restore a post-artifact fault", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-adapter-recovery-"));
    roots.push(root);
    const objectStore = new ZstdContentObjectStore(root);
    const repository = new SqliteSessionRepository(
      openMaintenanceDatabase(join(root, "metadata.sqlite")),
      objectStore,
    );
    repositories.push(repository);
    const source = normalizeSession({
      key: { platform: "codex", instanceId: "codex-fixture", sessionId: "codex-session" },
      title: "Imported session",
      archived: true,
      workspaceId: null,
      provenance: {
        platform: "codex",
        instanceId: "codex-fixture",
        sessionId: "codex-session",
        observedAt: "2026-08-27T00:00:00.000Z",
        sourceVersion: "0.146.0",
      },
      compatibility: { status: "compatible", issues: [] },
      events: [
        {
          sourceEventId: "codex-user-0",
          parentSourceEventId: null,
          sequence: 0,
          kind: "message",
          role: "user",
          content: "base prompt",
          attachments: [],
          extensions: {},
        },
        {
          sourceEventId: "codex-user-1",
          parentSourceEventId: null,
          sequence: 1,
          kind: "message",
          role: "user",
          content: "new prompt",
          attachments: [],
          extensions: {},
        },
        {
          sourceEventId: "codex-assistant-1",
          parentSourceEventId: null,
          sequence: 2,
          kind: "message",
          role: "assistant",
          content: "new response",
          attachments: [],
          extensions: { provider: "deepseek", model: "fixture-model" },
        },
      ],
    });
    const targetFingerprint = {
      platform: "dsh" as const,
      instanceId: "dsh-fixture",
      sessionId: "dsh-session-1",
      kind: "content" as const,
      value: "target-before",
    };
    const plan = createSyncPlan({
      createdAt: "2026-08-27T00:00:00.000Z",
      logicalSessionId: "logical-a",
      baseVersionId: "version-target",
      base: {
        events: source.events.slice(0, 1),
        metadata: { title: "Fixture conversation", archived: false },
      },
      source: {
        snapshot: {
          bindingId: "binding-codex",
          key: source.key,
          versionId: "version-source",
          fingerprints: [{ ...source.key, kind: "content", value: "source-before" }],
        },
        events: source.events,
        metadata: { title: source.title, archived: source.archived },
      },
      target: {
        kind: "present",
        head: {
          snapshot: {
            bindingId: "binding-dsh",
            key: {
              platform: "dsh",
              instanceId: "dsh-fixture",
              sessionId: "dsh-session-1",
            },
            versionId: "version-target",
            fingerprints: [targetFingerprint],
          },
          events: source.events.slice(0, 1),
          metadata: { title: "Fixture conversation", archived: false },
        },
      },
      adapterContracts: [
        {
          adapter: "dsh-write-core",
          platformVersion: "0.1.1-rc.2",
          schemaFingerprint: RC2_CORE_CONTRACT_FINGERPRINT,
        },
      ],
    });
    await repository.savePlan(plan);

    const host = createDshCoreFixtureHost();
    const before = host.domainDigests("dsh-session-1");
    host.setFault("after-session-mutation");
    const gateway = new DshHostGateway({
      extensions: new Map([["dsh-fixture", new LockedRc2CoreExtension(host)]]),
      tokens: new DshGatewayTokenService({
        secret: Buffer.alloc(32, 7),
        now: () => new Date("2026-08-27T00:00:00.000Z"),
      }),
      materializationProbe: async () => ({
        status: "compatible",
        sourceHash: "sha256:fixture-source",
        artifactHash: "sha256:fixture-artifact",
        issues: [],
      }),
    });
    const adapter = new DshWriteAdapter({
      stateRoot: root,
      gateway,
      loadSource: async () => source,
      now: () => new Date("2026-08-27T00:00:00.000Z"),
    });
    const executor = new TransactionExecutor({
      stateRoot: root,
      repository,
      adapters: new Map([["dsh", adapter]]),
      instances: new Map([
        [
          "dsh-fixture",
          {
            id: "dsh-fixture",
            platform: "dsh",
            displayName: "fixture",
            root: join(root, "marked-synthetic-dsh-home"),
            platformVersion: "0.1.1-rc.2",
          },
        ],
      ]),
      readFingerprints: async () => plan.preconditions,
      now: () => new Date("2026-08-27T00:00:00.000Z"),
      idFactory: () => "tx-adapter-recovery",
    });

    await expect(executor.apply({ planId: plan.id })).resolves.toMatchObject({
      status: "restored",
    });
    host.setFault(undefined);

    const descriptor = await new PreparedDshWriteStore(root).read("tx-adapter-recovery");
    expect(descriptor.phase).toBe("captured");
    expect(descriptor.events.map((event) => event.seq)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(descriptor.events.map((event) => event.type)).toEqual([
      "turn/start",
      "step/start",
      "user/message",
      "assistant/message",
      "step/end",
      "turn/end",
      "session/title",
    ]);
    expect((await repository.getBackupManifest("tx-adapter-recovery"))?.entries).toEqual([
      expect.objectContaining({ logicalName: "dsh-core-snapshot", required: true }),
    ]);
    expect(host.domainDigests("dsh-session-1")).toEqual(before);
  });
});
