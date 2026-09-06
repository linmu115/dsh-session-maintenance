import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DEFAULT_RETENTION_POLICY, planRetention } from "../src/retention-policy.js";
import { NOW, retentionFixture } from "./retention-fixture.js";

it("orders cache capacity candidates by newer verified refresh evidence without mutating registration", async () => {
  const f = await retentionFixture();
  try {
    for (const [id, used, refreshed] of [
      ["recently-refreshed", "2026-09-01T00:00:00.000Z", "2026-09-05T00:00:00.000Z"],
      ["older-refresh", "2026-09-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z"],
    ] as const) {
      const cache = await f.resource("cache", id);
      f.repository.registerResource({ ...cache.entry, lastUsedAt: used });
      await writeFile(
        join(cache.path, "projection-cache-manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          cacheKey: id,
          adapterId: "adapter",
          adapterFingerprint: "digest",
          configurationDigest: "configuration",
          lastAppliedRevision: 0,
          sessions: [],
          workspaces: [],
          createdAt: used,
          updatedAt: refreshed,
        }),
      );
      await writeFile(join(cache.path, "payload.json"), "synthetic cache");
    }
    const registry = f.repository.resources();
    const inventory = await f.repository.capture(NOW);
    const recent = inventory.resources.find((entry) => entry.resource.id === "recently-refreshed")!;
    expect(recent.resource.lastUsedAt).toBe("2026-09-05T00:00:00.000Z");
    expect(f.repository.resources()).toEqual(registry);
    const plan = planRetention(inventory, {
      ...DEFAULT_RETENTION_POLICY,
      cacheTargetBytes: recent.bytes,
    });
    expect(plan.items.find((item) => item.id === "older-refresh")).toMatchObject({
      disposition: "candidate",
      executable: true,
    });
    expect(plan.items.find((item) => item.id === "recently-refreshed")?.disposition).toBe("protected");
  } finally {
    await f.close();
  }
});
