import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { deterministicTarGz, readTarGz, sha256 } from "../../scripts/phase2-pack-lib.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("phase 2 package boundaries", () => {
  it("creates byte-identical sorted archives without timestamps or machine paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-phase2-tar-"));
    roots.push(root);
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "b.txt"), "two");
    await writeFile(join(root, "a.txt"), "one");
    const first = await deterministicTarGz(root, "package");
    const second = await deterministicTarGz(root, "package");
    expect(sha256(first)).toBe(sha256(second));
    expect([...readTarGz(first).keys()]).toEqual(["package/a.txt", "package/nested/b.txt"]);
    expect(first.toString("utf8")).not.toContain(root);
  });

  it("normalizes checkout line endings in release text while preserving one canonical archive", async () => {
    const left = await mkdtemp(join(tmpdir(), "dsh-phase2-lf-"));
    const right = await mkdtemp(join(tmpdir(), "dsh-phase2-crlf-"));
    roots.push(left, right);
    await writeFile(join(left, "README.md"), "one\ntwo\n");
    await writeFile(join(right, "README.md"), "one\r\ntwo\r\n");
    await writeFile(join(left, "index.js"), "export const ok = true;\n");
    await writeFile(join(right, "index.js"), "export const ok = true;\r\n");
    expect(sha256(await deterministicTarGz(left, "package"))).toBe(
      sha256(await deterministicTarGz(right, "package")),
    );
  });
});
