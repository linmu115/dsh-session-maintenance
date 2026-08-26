import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ZstdContentObjectStore } from "../src/index.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm-store-"));
  roots.push(root);
  return root;
}

function objectPath(root: string, id: string): string {
  const hex = id.slice("sha256:".length);
  return join(root, "objects", "sha256", hex.slice(0, 2), `${hex.slice(2)}.zst`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ZstdContentObjectStore", () => {
  it("deduplicates sequential and concurrent writes", async () => {
    const root = await temporaryRoot();
    const store = new ZstdContentObjectStore(root);
    const bytes = Buffer.from("same body");

    const first = await store.put(bytes);
    expect(await store.put(bytes)).toBe(first);
    expect(new Set(await Promise.all(Array.from({ length: 8 }, () => store.put(bytes))))).toEqual(
      new Set([first]),
    );
    expect(Buffer.from(await store.get(first)).toString("utf8")).toBe("same body");
  });

  it("rejects truncated objects and preserves dry-run GC candidates", async () => {
    const root = await temporaryRoot();
    const store = new ZstdContentObjectStore(root);
    const reachable = await store.put(Buffer.from("reachable"));
    const candidate = await store.put(Buffer.from("candidate"));

    const report = await store.collect({
      reachableObjectIds: [reachable],
      olderThan: "2999-01-01T00:00:00.000Z",
      dryRun: true,
    });
    expect(report).toMatchObject({
      reachableObjects: 1,
      retainedObjects: 1,
      deletedObjects: 1,
    });
    expect((await readFile(objectPath(root, candidate))).byteLength).toBeGreaterThan(0);

    await writeFile(objectPath(root, candidate), Buffer.from([0x28, 0xb5, 0x2f]));
    await expect(store.get(candidate)).rejects.toMatchObject({ code: "OBJECT_CORRUPT" });
  });
});
