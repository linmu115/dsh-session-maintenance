import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { backup } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_RETENTION_POLICY } from "@linmu/dsh-session-store";
import type { RetentionPreviewPlan } from "@linmu/dsh-session-contracts";
import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { createEngineFixture, hashTree } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("composes retention behind authentication, keeps preview read-only, and protects imported version bodies", async () => {
  const f = await createEngineFixture("sm08-http"); cleanups.push(f.cleanupAll);
  const server = await f.startServer();
  const client = new MaintenanceClient({ origin: server.origin, token: server.token });
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  const job = await client.importCodex({ operationId: "preview-source", instanceIds: ["codex-fixture"], mode: "content" });
  await server.jobs.waitForImport(job.id);
  const objectBytes = await hashTree(join(f.stateRoot, "objects")), originalHome = await hashTree(f.codexHome);
  const changes = () => f.engine.repository.database.prepare("SELECT total_changes() AS count").get();
  const before = changes();
  const preview = await client.previewRetention();
  expect(preview.blockers).toEqual([]);
  expect(preview.items.filter((item) => item.kind === "content-object").length).toBeGreaterThan(0);
  expect(preview.items.filter((item) => item.kind === "content-object").every((item) => item.disposition === "protected" && !item.executable)).toBe(true);
  expect(changes()).toEqual(before);
  expect(await hashTree(join(f.stateRoot, "objects"))).toBe(objectBytes);
  expect(await hashTree(f.codexHome)).toBe(originalHome);
  expect((await client.getRetentionRegistry()).sources.filter((source) => source.kind === "active-database")).toHaveLength(1);
  for (const path of ["preview", "execute", "restore", "purge", "discover", "roots", "sources", "verify"]) {
    expect((await fetch(`${server.origin}/v1/retention/${path}`, { method: "POST", body: "{}" })).status).toBe(401);
  }
  expect((await fetch(`${server.origin}/v1/retention/registry`, { headers: { ...headers, origin: "https://untrusted.invalid" } })).status).toBe(403);
  for (const [path, body] of [["preview?unexpected=1", {}], ["preview", { policy: { ...DEFAULT_RETENTION_POLICY, history: "five-days" } }], ["execute", { planId: "unknown", root: "override" }], ["sources", { id: "bad", rootId: "engine-state", relativePath: "../escape.sqlite", objectRootId: "engine-state", kind: "backup-database", retained: true }]] as const) {
    expect((await fetch(`${server.origin}/v1/retention/${path}`, { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(400);
  }
  await expect(client.executeRetention("unknown")).rejects.toThrow("PLAN_STALE");
});

it("uses the real coordinator for stale-plan refusal, explicit isolation, grace-period refusal and exact restoration", async () => {
  const f = await createEngineFixture("sm09-http"); cleanups.push(f.cleanupAll);
  const server = await f.startServer();
  const client = new MaintenanceClient({ origin: server.origin, token: server.token });
  const service = f.engine.retention!;
  const cachePath = join(f.stateRoot, "projection-runtime", "caches", "synthetic-cache");
  await mkdir(cachePath);
  await writeFile(join(cachePath, "projection-cache-manifest.json"), JSON.stringify({ schemaVersion: 1, cacheKey: "synthetic-cache", adapterId: "fixture-adapter", adapterFingerprint: "fixture-digest", configurationDigest: "fixture-config", lastAppliedRevision: 0, sessions: [], workspaces: [], createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" }));
  await writeFile(join(cachePath, "payload.json"), '{"synthetic":true}');
  await service.registerResource({ id: "synthetic-cache", rootId: "engine-caches", relativePath: "synthetic-cache", kind: "cache", ownerId: "synthetic-cache", group: "fixture" });
  await client.verifyRetention("synthetic-cache");
  const preview = async (): Promise<RetentionPreviewPlan> => {
    const response = await fetch(`${server.origin}/v1/retention/preview`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ policy: { ...DEFAULT_RETENTION_POLICY, cacheTargetBytes: 0 } }) });
    expect(response.status).toBe(200);
    return (await response.json() as { plan: RetentionPreviewPlan }).plan;
  };
  const stale = await preview();
  expect(stale.executableBytes).toBeGreaterThan(0);
  await writeFile(join(cachePath, "payload.json"), '{"synthetic":"changed"}');
  await expect(client.executeRetention(stale.id)).rejects.toThrow("PLAN_STALE");
  await client.verifyRetention("synthetic-cache");
  const before = await hashTree(cachePath);
  const batch = await client.executeRetention((await preview()).id);
  expect(batch.items[0]?.state).toBe("quarantined");
  expect((await client.listRetentionBatches())[0]?.id).toBe(batch.id);
  await expect(readFile(join(cachePath, "payload.json"))).rejects.toThrow();
  await expect(client.purgeRetention(batch.id)).rejects.toThrow("CONFIRMATION_REQUIRED");
  expect((await client.restoreRetention(batch.id)).items[0]?.state).toBe("restored");
  expect(await hashTree(cachePath)).toBe(before);
  expect((await client.restoreRetention(batch.id)).items[0]?.state).toBe("restored");
});

it("connects flat database registration to verified whole-bundle isolation and restoration", async () => {
  const f = await createEngineFixture("sm09-flat-http"); cleanups.push(f.cleanupAll);
  const server = await f.startServer();
  const client = new MaintenanceClient({ origin: server.origin, token: server.token });
  const files: Array<{ path: string; digest: string; manifest: string }> = [];
  for (let i = 0; i < 4; i++) {
    const name = `synthetic-candidate-${i}.sqlite`, path = join(f.stateRoot, name);
    await f.engine.runWrite("fixture-static-snapshot", () => backup(f.engine.repository.database, path));
    const digest = `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
    const manifest = JSON.stringify({ schemaVersion: 1, candidatePath: path, candidateDigest: digest });
    await writeFile(`${path}.manifest.json`, manifest);
    await client.registerRetentionSource({ id: `source-${i}`, rootId: "engine-state", relativePath: name, objectRootId: "engine-state", kind: "candidate-database", retained: true });
    expect(await client.registerFlatRetentionCandidate(`source-${i}`)).toMatchObject({ kind: "candidate", sqliteBundle: [name, `${name}.manifest.json`] });
    files.push({ path, digest, manifest });
  }
  const preview = await client.previewRetention();
  expect(preview.blockers).toEqual([]);
  expect(preview.items.filter((item) => item.kind === "candidate" && item.executable)).toHaveLength(1);
  const batch = await client.executeRetention(preview.id);
  expect(batch.items).toHaveLength(1);
  await expect(readFile(files[0]!.path)).rejects.toThrow();
  await expect(readFile(`${files[0]!.path}.manifest.json`)).rejects.toThrow();
  expect((await client.previewRetention()).blockers).toEqual([]);
  expect((await client.restoreRetention(batch.id)).items[0]?.state).toBe("restored");
  expect(`sha256:${createHash("sha256").update(await readFile(files[0]!.path)).digest("hex")}`).toBe(files[0]!.digest);
  expect(await readFile(`${files[0]!.path}.manifest.json`, "utf8")).toBe(files[0]!.manifest);
});
