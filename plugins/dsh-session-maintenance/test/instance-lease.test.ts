import { expect, it, vi } from "vitest";
import { instanceLivenessAnswerSchema } from "@linmu/dsh-session-contracts";
import { InstanceLeasePublisher, createInstanceLeaseHandler, instanceLeaseFor } from "../src/instance-lease.js";

const at = "2026-09-21T10:00:00.000Z";
const identity = { instanceId: "i-one", profileId: "web", homeRoot: "C:\\合成\\my-dsh-home",
  runtimeUrl: "http://127.0.0.1:19876", pid: 4242, processStartedAt: "2026-09-21T09:59:00.000Z" };
const clock = () => at;

/** Minimal request/response doubles: the handler is what is under test, not the host. */
function exchange(body: unknown, method = "POST") {
  const chunks = [Buffer.from(JSON.stringify(body))];
  const request = { method, async *[Symbol.asyncIterator]() { yield* chunks; } };
  let status = 0, payload = "";
  const response = {
    writeHead(code: number) { status = code; return this; },
    end(value?: string) { payload = value ?? ""; },
  };
  return { request, response, done: () => ({ status, body: payload === "" ? undefined : JSON.parse(payload) as unknown }) };
}

it("describes the instance exactly as the Engine side expects", () => {
  expect(instanceLeaseFor(identity, "idle", null, clock)).toEqual({ schemaVersion: 1, instanceId: "i-one", profileId: "web",
    pid: 4242, processStartedAt: "2026-09-21T09:59:00.000Z", homeRoot: "C:\\合成\\my-dsh-home",
    runtimeUrl: "http://127.0.0.1:19876", state: "idle", attachedRunId: null, updatedAt: at });
});

it("publishes on change only and reports a write failure once per message", async () => {
  const written: unknown[] = [];
  const failures: string[] = [];
  const publisher = new InstanceLeasePublisher(identity, async lease => { written.push(lease); }, message => failures.push(message), clock);
  await publisher.publish();
  await publisher.publish();
  // The Engine may read at any time, so an unchanged lease is not rewritten.
  expect(written).toHaveLength(1);
  await publisher.publish("attached", "run-one");
  expect(written).toHaveLength(2);
  expect(publisher.current()).toEqual({ state: "attached", attachedRunId: "run-one" });
  await publisher.stopping();
  expect(written).toHaveLength(3);

  const broken = new InstanceLeasePublisher(identity, async () => { throw new Error("synthetic disk failure"); }, message => failures.push(message), clock);
  await broken.publish();
  await broken.publish();
  // An instance that cannot write its lease still runs; it just cannot be discovered.
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("synthetic disk failure");
});

it("answers the liveness challenge with its own identity and denies a mismatched one", async () => {
  const publisher = new InstanceLeasePublisher(identity, async () => undefined, () => undefined, clock);
  await publisher.publish("attached", "run-one");
  const handler = createInstanceLeaseHandler({ identity, publisher });
  const matched = exchange({ schemaVersion: 1, instanceId: "i-one", profileId: "web", pid: 4242, homeRoot: identity.homeRoot });
  await handler(matched.request as never, matched.response as never);
  expect(matched.done().status).toBe(200);
  expect(instanceLivenessAnswerSchema.parse(matched.done().body)).toEqual({ schemaVersion: 1, responder: "dsh-session-maintenance",
    instanceId: "i-one", profileId: "web", matched: true, pid: 4242, homeRoot: identity.homeRoot, state: "attached", attachedRunId: "run-one" });

  // Another instance asking, or the same instance with a different process, is answered and denied.
  for (const challenge of [
    { schemaVersion: 1, instanceId: "i-other", profileId: "web", pid: 4242, homeRoot: identity.homeRoot },
    { schemaVersion: 1, instanceId: "i-one", profileId: "other", pid: 4242, homeRoot: identity.homeRoot },
    { schemaVersion: 1, instanceId: "i-one", profileId: "web", pid: 1, homeRoot: identity.homeRoot },
    { schemaVersion: 1, instanceId: "i-one", profileId: "web", pid: 4242, homeRoot: "C:\\合成\\another" },
  ]) {
    const denied = exchange(challenge);
    await handler(denied.request as never, denied.response as never);
    expect(denied.done().status).toBe(200);
    expect(instanceLivenessAnswerSchema.parse(denied.done().body).matched).toBe(false);
  }
});

it("refuses a malformed or non-POST challenge instead of guessing", async () => {
  const publisher = new InstanceLeasePublisher(identity, async () => undefined, () => undefined, clock);
  const handler = createInstanceLeaseHandler({ identity, publisher });
  const wrongMethod = exchange({ schemaVersion: 1, instanceId: "i-one", profileId: "web", pid: 4242, homeRoot: identity.homeRoot }, "GET");
  await handler(wrongMethod.request as never, wrongMethod.response as never);
  expect(wrongMethod.done().status).toBe(405);
  const unsupported = exchange({ schemaVersion: 2, instanceId: "i-one" });
  await handler(unsupported.request as never, unsupported.response as never);
  expect(unsupported.done().status).toBe(400);
  const unreadable = exchange("not an object");
  await handler(unreadable.request as never, unreadable.response as never);
  expect(unreadable.done().status).toBe(400);
});
