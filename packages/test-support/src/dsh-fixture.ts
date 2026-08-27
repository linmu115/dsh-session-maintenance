import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";

import { assertFixtureSandbox } from "./sandbox.js";

const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../fixtures/dsh/0.1.1-rc.2");

function encodeFrame(bytes: Uint8Array): Buffer {
  return zstdCompressSync(bytes, {
    params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
  });
}

export async function writeDshFixtureHome(root: string): Promise<void> {
  assertFixtureSandbox(root);
  const existing = await readdir(root);
  if (existing.length > 0) {
    throw new Error(`DSH fixture destination must be empty: ${root}`);
  }

  const sessionDirectory = join(root, "sessions", "project-fixture", "dsh-session-1");
  const storages = join(root, "storages");
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(storages);

  const header = await readFile(join(FIXTURE_ROOT, "header.json"));
  const events = await readFile(join(FIXTURE_ROOT, "events.jsonl"));
  await writeFile(
    join(sessionDirectory, "session.jsonl.zstd"),
    Buffer.concat([encodeFrame(header), encodeFrame(events)]),
  );
  await writeFile(
    join(storages, "workspace.json"),
    `${JSON.stringify({
      unit: { name: "workspace", version: 2 },
      global: {
        initialized: true,
        workspaceIds: ["workspace-fixture"],
        archivedSessionIds: [],
      },
      tables: {
        workspaces: {
          "workspace-fixture": {
            path: "C:\\fixture\\workspace",
            title: "Fixture workspace",
            sessionIds: ["dsh-session-1"],
            createdAt: "2026-08-27T00:00:00.000Z",
            updatedAt: "2026-08-27T00:00:00.000Z",
          },
        },
      },
    })}\n`,
  );
  await writeFile(
    join(storages, "session_projcache.json"),
    `${JSON.stringify({
      unit: { name: "session_projcache", version: 3 },
      global: null,
      tables: {
        sessions: {
          "dsh-session-1": {
            identity: { createdAt: 1, cwd: "C:\\fixture\\workspace" },
            rows: {
              title: { ver: 1, seq: 2, val: "Fixture conversation" },
              sessionListMetadata: { ver: 1, seq: 2, val: { blank: false, lastPromptAt: 2 } },
            },
          },
        },
      },
    })}\n`,
  );
}
