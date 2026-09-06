import { afterEach, describe, expect, it } from "vitest";
import { MAINTENANCE_SCHEMA_VERSION } from "@linmu/dsh-session-store";

import { createEngineFixture } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("canonical migration preview API", () => {
  it("exposes an authenticated read-only preview and does not create the candidate", async () => {
    const fixture = await createEngineFixture("canonical-migration-preview-api");
    cleanups.push(fixture.cleanupAll);
    const server = await fixture.startServer();

    expect((await fetch(`${server.origin}/v1/migrations/canonical/preview`)).status).toBe(401);
    const response = await fetch(`${server.origin}/v1/migrations/canonical/preview`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      readonly preview: {
        readonly sourceSchemaVersion: number;
        readonly candidate: { readonly exists: boolean; readonly created: boolean };
        readonly rollback: { readonly sourcePreserved: boolean };
      };
    };
    expect(body.preview).toMatchObject({
      sourceSchemaVersion: MAINTENANCE_SCHEMA_VERSION,
      candidate: { exists: false, created: false },
      rollback: { sourcePreserved: true },
    });
    await expect(access(join(fixture.stateRoot, "metadata.canonical-candidate.sqlite")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
import { access } from "node:fs/promises";
import { join } from "node:path";
