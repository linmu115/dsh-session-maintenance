import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteSessionRepository,
  ZstdContentObjectStore,
  openMaintenanceDatabase,
} from "@linmu/dsh-session-store";

import { ConfirmationService } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("ConfirmationService", () => {
  it("issues a scoped single-use nonce and rejects replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-confirm-"));
    roots.push(root);
    const repository = new SqliteSessionRepository(
      openMaintenanceDatabase(join(root, "metadata.sqlite")),
      new ZstdContentObjectStore(root),
    );
    const service = new ConfirmationService(repository, {
      now: () => new Date("2026-08-27T00:00:00.000Z"),
      randomToken: () => "nonce-secret",
    });
    const issued = await service.issue({
      operation: "restore",
      resourceId: "tx-a",
      operationHash: "sha256:operation",
    });

    await expect(service.consume({ ...issued, operationHash: "sha256:wrong" })).rejects.toMatchObject({
      code: "CONFIRMATION_SCOPE_MISMATCH",
    });
    await expect(service.consume(issued)).resolves.toBeUndefined();
    await expect(service.consume(issued)).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    repository.close();
  });

  it("rejects an expired nonce", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-confirm-expired-"));
    roots.push(root);
    const repository = new SqliteSessionRepository(
      openMaintenanceDatabase(join(root, "metadata.sqlite")),
      new ZstdContentObjectStore(root),
    );
    let now = new Date("2026-08-27T00:00:00.000Z");
    const service = new ConfirmationService(repository, {
      now: () => now,
      randomToken: () => "nonce-expired",
      ttlMs: 100,
    });
    const issued = await service.issue({
      operation: "restore",
      resourceId: "tx-a",
      operationHash: "sha256:operation",
    });
    now = new Date("2026-08-27T00:00:01.000Z");
    await expect(service.consume(issued)).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    repository.close();
  });
});
