import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readLauncherInstanceDirectory } from "../src/integrations/launcher-instance-directory.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "launcher-name-fixture-")); roots.push(root); await writeFile(join(root, ".synthetic-fixture"), "No real Launcher or user homes"); return root; }
it("reads current names and new offline instances, follows renames without probing homes", async () => {
  const root = await fixture();
  const write = (name: string) => writeFile(join(root, "config.json"), JSON.stringify({ instances: [{ id: "copy", name }, { id: "new", name: "测试" }] }));
  await write("副本");
  expect(await readLauncherInstanceDirectory(root)).toEqual([{ instanceId: "copy", name: "副本" }, { instanceId: "new", name: "测试" }]);
  await write("重命名副本");
  expect((await readLauncherInstanceDirectory(root))![0]).toEqual({ instanceId: "copy", name: "重命名副本" });
});
it("distinguishes missing and empty catalogs, permits duplicate names, rejects duplicate identities", async () => {
  const root = await fixture();
  expect(await readLauncherInstanceDirectory(root)).toBeNull();
  await writeFile(join(root, "config.json"), JSON.stringify({ instances: [] }));
  expect(await readLauncherInstanceDirectory(root)).toEqual([]);
  await writeFile(join(root, "config.json"), JSON.stringify({ instances: [{ id: "a", name: "同名" }, { id: "b", name: "同名" }] }));
  expect(await readLauncherInstanceDirectory(root)).toHaveLength(2);
  await writeFile(join(root, "config.json"), JSON.stringify({ instances: [{ id: "a", name: "一" }, { id: "a", name: "二" }] }));
  await expect(readLauncherInstanceDirectory(root)).rejects.toMatchObject({ code: "LAUNCHER_CATALOG_INVALID" });
  await writeFile(join(root, "config.json"), "{broken");
  await expect(readLauncherInstanceDirectory(root)).rejects.toMatchObject({ code: "LAUNCHER_CATALOG_INVALID" });
});
