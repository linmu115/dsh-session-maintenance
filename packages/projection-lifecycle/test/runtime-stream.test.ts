import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue, NativeSessionId } from "@linmu/dsh-session-adapter-sdk";
import type { RunId } from "@linmu/dsh-session-contracts";

import { JsonProjectionDirectory, projectionRootFor } from "../src/materialize.js";
import { writeProjectionRecoveryDescriptor } from "../src/recovery.js";
import {
  PROJECTION_CATALOG_CHUNK_TARGET_BYTES,
  PROJECTION_EVENT_CHUNK_TARGET_BYTES,
  PROJECTION_EVENT_HARD_LIMIT_BYTES,
  openProjectionRuntimeSessionStream,
  openProjectionRuntimeStream,
} from "../src/runtime-stream.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function collect(frames: AsyncIterable<string>): Promise<Array<{ readonly [key: string]: JsonValue }>> {
  const output: Array<{ readonly [key: string]: JsonValue }> = [];
  for await (const frame of frames) output.push(JSON.parse(frame) as { readonly [key: string]: JsonValue });
  return output;
}

async function fixture(count: number) {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "dsh-maint-projection-stream-"));
  cleanups.push(() => rm(runtimeRoot, { recursive: true, force: true }));
  const runId = "run-stream-test" as RunId;
  const directory = new JsonProjectionDirectory(projectionRootFor(runtimeRoot, runId));
  await directory.initialize();
  for (let index = 0; index < count; index += 1) {
    const nativeSessionId = `native-${index.toString().padStart(3, "0")}` as NativeSessionId;
    await directory.writeSession(nativeSessionId, {
      schemaVersion: 1,
      logicalSessionId: `logical-${index}`,
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      title: `Session ${index}`,
      header: { version: 0, id: nativeSessionId, createdAt: index },
      events: [{ type: "test/event", seq: 0, time: index, data: { index } }],
    });
  }
  await directory.rebuildSessionCatalog(runId);
  return { runtimeRoot, runId, directory };
}

describe("bounded projection runtime NDJSON", () => {
  it("N02: sends only metadata in persistent-native mode regardless of the requested hot limit", async () => {
    const { runtimeRoot, runId, directory } = await fixture(3);
    await writeProjectionRecoveryDescriptor(directory.root, { schemaVersion: 1, runId, maintenanceEndpoint: "synthetic",
      nativeSpace: { schemaVersion: 1, key: "synthetic", root: join(runtimeRoot, "native") } });
    const frames = await collect((await openProjectionRuntimeStream(runtimeRoot, runId, 1000)).frames);
    expect(frames[0]).toMatchObject({ nativeMode: "persistent-native-v1", hotLimit: 0, sessionCount: 3 });
    expect(frames.map(frame => frame.type)).toEqual(["catalog-begin", "catalog-sessions", "catalog-end"]);
  });
  it("sorts the sidecar by canonical updatedAt and marks exactly the newest 200 sessions hot", async () => {
    const { runtimeRoot, runId, directory } = await fixture(201);
    const sidecar = await directory.readSessionCatalog(runId);
    expect(sidecar.sessions).toHaveLength(201);
    expect(sidecar.sessions[0]?.nativeSessionId).toBe("native-200");
    expect(sidecar.sessions.at(-1)?.nativeSessionId).toBe("native-000");
    expect(sidecar.sessions[0]?.payload).toMatchObject({ updatedAt: sidecar.sessions[0]?.updatedAt, events: [] });

    const frames = await collect((await openProjectionRuntimeStream(runtimeRoot, runId, 200)).frames);
    expect(frames[0]).toMatchObject({ type: "catalog-begin", schemaVersion: 2, sessionCount: 201 });
    const sessions = frames.filter((frame) => frame.type === "catalog-sessions")
      .flatMap((frame) => frame.sessions as unknown as Array<{ readonly nativeSessionId: string; readonly hot: boolean }>);
    expect(sessions.filter((session) => session.hot)).toHaveLength(200);
    expect(sessions[199]).toMatchObject({ nativeSessionId: "native-001", hot: true });
    expect(sessions[200]).toMatchObject({ nativeSessionId: "native-000", hot: false });
    expect(frames.find((frame) => frame.type === "catalog-end")).toMatchObject({ sessionCount: 201 });
    expect(frames.filter((frame) => frame.type === "session-begin")).toHaveLength(200);
    expect(frames.some((frame) => frame.nativeSessionId === "native-000" && frame.type === "session-begin")).toBe(false);
  });

  it("segments a lightweight catalog larger than 4 MiB without loading any cold history", async () => {
    const { runtimeRoot, runId, directory } = await fixture(12);
    for (let index = 0; index < 12; index += 1) {
      const nativeSessionId = `native-${index.toString().padStart(3, "0")}` as NativeSessionId;
      const original = await directory.readSession(nativeSessionId) as { readonly [key: string]: JsonValue };
      await directory.replaceSession(nativeSessionId, { ...original, title: `${index}:${"x".repeat(400 * 1024)}` });
    }
    const lines: string[] = [];
    for await (const frame of (await openProjectionRuntimeStream(runtimeRoot, runId, 0)).frames) lines.push(frame);
    const frames = lines.map((frame) => JSON.parse(frame) as { readonly [key: string]: JsonValue });
    const catalogLines = lines.filter((_, index) => frames[index]?.type === "catalog-sessions");
    expect(Buffer.byteLength(catalogLines.join(""), "utf8")).toBeGreaterThan(4 * 1024 * 1024);
    expect(catalogLines).toHaveLength(12);
    expect(catalogLines.every((frame) => Buffer.byteLength(frame, "utf8") <= PROJECTION_CATALOG_CHUNK_TARGET_BYTES)).toBe(true);
    expect(frames.filter((frame) => frame.type === "session-begin")).toHaveLength(0);
  });

  it("rebuilds hot and cold sessions from ordered frames and bounds event chunks", async () => {
    const { runtimeRoot, runId, directory } = await fixture(2);
    const nativeSessionId = "native-001" as NativeSessionId;
    const largeEvents = [
      { type: "large", data: "a".repeat(300 * 1024) },
      { type: "large", data: "b".repeat(300 * 1024) },
      { type: "large", data: "c".repeat(600 * 1024) },
    ];
    await directory.replaceSession(nativeSessionId, {
      schemaVersion: 1,
      logicalSessionId: "logical-1",
      updatedAt: "2026-09-01T00:00:00.000Z",
      title: "Chunked",
      header: { version: 0, id: nativeSessionId, createdAt: 1 },
      events: largeEvents,
    });

    const startupLines: string[] = [];
    for await (const frame of (await openProjectionRuntimeStream(runtimeRoot, runId, 1)).frames) startupLines.push(frame);
    const startupFrames = startupLines.map((frame) => JSON.parse(frame) as { readonly [key: string]: JsonValue });
    const eventLines = startupLines.filter((_, index) => startupFrames[index]?.type === "events");
    expect(eventLines).toHaveLength(3);
    expect(eventLines.slice(0, 2).every((frame) => Buffer.byteLength(frame, "utf8") <= PROJECTION_EVENT_CHUNK_TARGET_BYTES)).toBe(true);
    expect(Buffer.byteLength(eventLines[2]!, "utf8")).toBeLessThan(PROJECTION_EVENT_HARD_LIMIT_BYTES);
    const rebuiltHot = startupFrames
      .filter((frame) => frame.type === "events")
      .flatMap((frame) => frame.events as JsonValue[]);
    expect(rebuiltHot).toEqual(largeEvents);
    expect(startupFrames.at(-1)).toMatchObject({ type: "session-end", nativeSessionId, eventCount: 3 });

    const cold = await openProjectionRuntimeSessionStream(runtimeRoot, runId, "native-000" as NativeSessionId);
    expect(cold).toBeDefined();
    const coldFrames = await collect(cold!.frames);
    expect(coldFrames.map((frame) => frame.type)).toEqual(["session-begin", "events", "session-end"]);
    expect((coldFrames[1]?.events as JsonValue[])[0]).toMatchObject({ data: { index: 0 } });
  });

  it("returns undefined for an unknown cold session and rejects a stale catalog", async () => {
    const { runtimeRoot, runId, directory } = await fixture(1);
    await expect(openProjectionRuntimeSessionStream(runtimeRoot, runId, "missing" as NativeSessionId)).resolves.toBeUndefined();

    const nativeSessionId = "native-000" as NativeSessionId;
    const path = projectionRootFor(runtimeRoot, runId);
    const detachedDirectory = new JsonProjectionDirectory(path);
    const original = await detachedDirectory.readSession(nativeSessionId) as { readonly [key: string]: JsonValue };
    await detachedDirectory.replaceSession(nativeSessionId, { ...original, events: [] });
    // Restore the old event count to simulate a torn/stale external projection update.
    const sidecar = await directory.readSessionCatalog(runId);
    const stale = { ...sidecar, sessions: sidecar.sessions.map((entry) => ({ ...entry, eventCount: 1 })) };
    const sidecarPath = join(path, "session-catalog.json");
    await writeFile(sidecarPath, `${JSON.stringify(stale)}\n`, "utf8");
    await expect(openProjectionRuntimeSessionStream(runtimeRoot, runId, nativeSessionId)).rejects.toMatchObject({
      code: "PROJECTION_CATALOG_STALE",
    });
  });
});
