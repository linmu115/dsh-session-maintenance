import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { MaintenanceWriteCoordinator } from "@linmu/dsh-session-store";
import { businessPageSnapshotSchema, type BusinessPageOwner, type BusinessPageSnapshot, type BusinessPageActionRequest } from "@linmu/dsh-session-contracts";
import { BusinessPageRegistry } from "../src/business-pages.js";
import { routeBusinessPageRequest } from "../src/http/business-page-routes.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const item of cleanup.splice(0)) await item(); });
const owner: BusinessPageOwner = { instanceId: "instance", profileId: "web", namespace: "bridge", providerId: "vault-binding", bootId: "550e8400-e29b-41d4-a716-446655440000" };
const snapshot: BusinessPageSnapshot = { title: "Bridge", revision: 1, sections: [{ id: "bind", title: "Binding", kind: "actions", actions: [{ id: "bind", label: "Bind", expectedRevision: 4, fields: [{ id: "vault", label: "Vault", kind: "text", required: true }] }] }] };
const action: BusinessPageActionRequest = { owner, operationId: "550e8400-e29b-41d4-a716-446655440002", actionId: "bind", expectedRevision: 4, input: { vault: "fixture" } };
async function fixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), "dsh-sm-business-pages-fixture-"));
  await writeFile(join(stateRoot, ".synthetic-fixture"), "Synthetic business pages\n");
  const writes = MaintenanceWriteCoordinator.acquire(stateRoot); let clock = 1000;
  cleanup.push(async () => { await writes.drain(); writes.close(); await rm(stateRoot, { recursive: true, force: true }); });
  const options = { stateRoot, writes, now: () => clock };
  const registry = await BusinessPageRegistry.create(options);
  return { registry, options, advance: () => { clock += 30_000; } };
}
it("retains independent providers and offline pages while fencing active and stale boot owners", async () => {
  const { registry, advance } = await fixture();
  await registry.register({ owner, snapshot });
  const second = { ...owner, providerId: "notes" };
  await registry.register({ owner: second, snapshot });
  const replacement = { ...owner, bootId: "550e8400-e29b-41d4-a716-446655440001" };
  await expect(registry.register({ owner: replacement, snapshot })).rejects.toMatchObject({ code: "BUSINESS_PAGE_OWNER_ACTIVE" });
  await registry.unregister(second); expect(registry.list().pages.map(page => page.online)).toEqual([true, false]);
  advance(); await registry.register({ owner: replacement, snapshot });
  await registry.unregister(owner); expect(registry.list().pages[0]?.online).toBe(true);
  await expect(registry.poll(owner)).rejects.toMatchObject({ code: "BUSINESS_PAGE_OFFLINE" });
});
it("allowlists action names, revisions and declared fields, with durable operation idempotency", async () => {
  const { registry } = await fixture(); await registry.register({ owner, snapshot });
  for (const request of [{ ...action, actionId: "eval" }, { ...action, expectedRevision: 3 }, { ...action, input: { vault: "fixture", arbitrary: "javascript" } }])
    await expect(registry.enqueue(request)).rejects.toBeTruthy();
  expect((await registry.enqueue(action)).status).toBe("queued");
  expect((await registry.poll(owner)).actions).toEqual([action]);
  await registry.acknowledge({ owner, operationId: action.operationId, status: "completed", message: "Companion confirmed" });
  expect((await registry.enqueue(action)).status).toBe("completed");
  expect((await registry.poll(owner)).actions).toEqual([]);
  await expect(registry.enqueue({ ...action, input: { vault: "another" } })).rejects.toMatchObject({ code: "BUSINESS_ACTION_CONFLICT" });
});
it("marks unfinished operations uncertain on Engine restart and never replays them", async () => {
  const { registry, options } = await fixture(); await registry.register({ owner, snapshot });
  await registry.enqueue(action); await registry.poll(owner);
  const reopened = await BusinessPageRegistry.create(options);
  expect(reopened.list().pages[0]?.online).toBe(false);
  expect(reopened.receipt(owner, action.operationId).status).toBe("uncertain");
  await reopened.register({ owner, snapshot });
  expect((await reopened.poll(owner)).actions).toEqual([]);
  await expect(reopened.acknowledge({ owner, operationId: action.operationId, status: "completed", message: "late" })).rejects.toMatchObject({ code: "BUSINESS_ACTION_UNCERTAIN" });
});
it("rejects browser calls to every provider endpoint before body parsing and accepts only structural snapshots", async () => {
  const { registry } = await fixture();
  for (const path of ["register", "heartbeat", "unregister", "poll", "ack"]) {
    const request = Object.assign(Readable.from([]), { method: "POST" }) as IncomingMessage;
    await expect(routeBusinessPageRequest(request, { setHeader: vi.fn(), end: vi.fn() } as unknown as ServerResponse,
      new URL(`http://127.0.0.1/v1/business-pages/${path}`), { businessPages: registry, hostAuthenticated: false })).rejects.toMatchObject({ status: 403 });
  }
  expect(() => businessPageSnapshotSchema.parse({ title: "Unsafe", revision: 1, sections: [{ id: "x", title: "x", kind: "html", html: "<script/>" }] })).toThrow();
  expect(() => businessPageSnapshotSchema.parse({ ...snapshot, sections: [...snapshot.sections, ...snapshot.sections] })).toThrow();
});
