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
      schemaVersion: 1,
      workspaces: [{ id: "workspace-fixture", projectId: "project-fixture", root: "C:\\fixture\\workspace" }],
    })}\n`,
  );
  await writeFile(
    join(storages, "session_projcache.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      sessions: [{ id: "dsh-session-1", projectId: "project-fixture", archived: false, title: "Fixture conversation" }],
    })}\n`,
  );
}
