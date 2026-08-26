import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AdapterProbe,
  ContentObjectStore,
  ExpectedPlatformState,
  GcPolicy,
  GcReport,
  NormalizedSession,
  PlatformSessionKey,
  PlatformSessionSummary,
  RegisteredInstance,
  ScanCursor,
  SessionReadAdapter,
  StableObservation,
  VerificationResult,
} from "@linmu/dsh-session-contracts";
import { DiscoveryService, sha256Canonical } from "../../packages/session-domain/src/index.js";
import { SqliteSessionRepository, ZstdContentObjectStore, openMaintenanceDatabase } from "../../packages/session-store/src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class CountingStore implements ContentObjectStore {
  gets = 0;
  constructor(readonly inner: ZstdContentObjectStore) {}
  put(bytes: Uint8Array): Promise<string> { return this.inner.put(bytes); }
  get(hash: string): Promise<Uint8Array> { this.gets += 1; return this.inner.get(hash); }
  collect(policy: GcPolicy): Promise<GcReport> { return this.inner.collect(policy); }
}

class CatalogAdapter implements SessionReadAdapter {
  readonly platform = "codex" as const;
  observes = 0;
  active = 0;
  maxActive = 0;
  constructor(readonly count: number) {}
  probe(): Promise<AdapterProbe> {
    return Promise.resolve({
      status: "compatible",
      contract: { adapter: "counting", platformVersion: "fixture", schemaFingerprint: "fixture-v1" },
      capabilities: ["list", "observe", "normalize", "verify-read"],
      issues: [],
    });
  }
  async *list(instance: RegisteredInstance, cursor?: ScanCursor): AsyncIterable<PlatformSessionSummary> {
    const start = Number.parseInt(cursor?.opaque ?? "0", 10);
    for (let index = start; index < this.count; index += 1) {
      yield {
        key: { platform: "codex", instanceId: instance.id, sessionId: `session-${index}` },
        title: `Session ${index}`,
        archived: false,
        workspaceId: "workspace",
        updatedAt: "2026-08-26T00:00:00.000Z",
        hint: { size: index + 1, mtimeNs: "1", eventCount: 1 },
      };
    }
  }
  async observe(_instance: RegisteredInstance, key: PlatformSessionKey): Promise<StableObservation> {
    this.observes += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    this.active -= 1;
    return { kind: "stable", key, fingerprint: { ...key, kind: "content", value: key.sessionId }, payload: key.sessionId };
  }
  normalize(observation: StableObservation): Promise<NormalizedSession> {
    const content = String(observation.payload);
    return Promise.resolve({
      schemaVersion: 1,
      key: observation.key,
      title: content,
      archived: false,
      workspaceId: "workspace",
      events: [{
        id: `event-${content}`,
        parentId: null,
        sequence: 0,
        kind: "message",
        role: "user",
        content,
        attachments: [],
        source: { ...observation.key, sequence: 0 },
        extensions: {},
      }],
      bodyHash: sha256Canonical({ content }),
      metadataHash: sha256Canonical({ title: content, archived: false }),
      provenance: { ...observation.key, observedAt: "2026-08-26T00:00:00.000Z" },
      compatibility: { status: "compatible", issues: [] },
    });
  }
  verify(_instance: RegisteredInstance, _key: PlatformSessionKey, expected: ExpectedPlatformState): Promise<VerificationResult> {
    return Promise.resolve({ ok: true, fingerprints: expected.fingerprints, issues: [] });
  }
}

describe("large catalog lazy-read contract", () => {
  it("bounds observations to four workers and skips all unchanged bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-large-"));
    roots.push(root);
    const store = new CountingStore(new ZstdContentObjectStore(root));
    const repository = new SqliteSessionRepository(openMaintenanceDatabase(join(root, "metadata.sqlite")), store);
    const adapter = new CatalogAdapter(1_000);
    const discovery = new DiscoveryService({
      instances: [{ id: "catalog", platform: "codex", displayName: "Catalog", root, platformVersion: "fixture" }],
      adapters: [adapter],
      repository,
      objectStore: store,
    });
    expect((await discovery.scanAll()).createdVersions).toBe(1_000);
    expect(adapter.maxActive).toBeGreaterThan(1);
    expect(adapter.maxActive).toBeLessThanOrEqual(4);
    adapter.observes = 0;
    store.gets = 0;
    expect(await discovery.scanAll()).toMatchObject({ createdVersions: 0, createdBindings: 0, platformWrites: 0 });
    expect(adapter.observes).toBe(0);
    expect((await repository.listSessions({ limit: 50 })).items).toHaveLength(50);
    expect(store.gets).toBe(0);
    const first = (await repository.listSessions({ limit: 1 })).items[0]!;
    expect((await repository.getGraphPage(first.logicalSessionId)).nodes).toHaveLength(1);
    expect(store.gets).toBe(0);
    repository.close();
  }, 30_000);
});
