import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { deterministicTarGz, sha256, stableJson } from "./phase2-pack-lib.mjs";
import { verifyEmbeddedIntegrationPackage } from "./verify-phase2-package.mjs";

test("embedded integration package verification", async (t) => {
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const artifacts = join(workspace, ".artifacts");
  await mkdir(artifacts, { recursive: true });
  const fixture = await mkdtemp(join(artifacts, "synthetic-integration-package-"));
  await writeFile(join(fixture, "SYNTHETIC-FIXTURE"), "Synthetic packaging test; no user homes or installations.\n");
  const root = join(fixture, "engine-root");
  const directory = join(root, "engine");
  await mkdir(directory, { recursive: true });
  const pluginBytes = Buffer.from("synthetic standalone plugin archive bytes");
  const manifest = { schemaVersion: 1, file: "dsh-session-maintenance.tgz", sha256: sha256(pluginBytes).slice(7) };
  const archive = async (descriptor = manifest, embedded = pluginBytes) => {
    await writeFile(join(directory, "dsh-session-maintenance.tgz"), embedded);
    await writeFile(join(directory, "integration-package.json"), `${stableJson(descriptor)}\n`);
    return deterministicTarGz(root, "dsh-session-maintenance");
  };
  try {
    await t.test("matching embedded bytes and unprefixed digest pass reproducibly", async () => {
      const first = await archive();
      assert.doesNotThrow(() => verifyEmbeddedIntegrationPackage(first, pluginBytes));
      assert.deepEqual(await archive(), first);
    });
    await t.test("different plugin bytes fail even when their descriptor is self-consistent", async () => {
      const different = Buffer.from("another synthetic package");
      const bytes = await archive({ ...manifest, sha256: sha256(different).slice(7) }, different);
      assert.throws(() => verifyEmbeddedIntegrationPackage(bytes, pluginBytes), /differs from standalone/u);
    });
    await t.test("incorrect digest fails", async () => {
      const bytes = await archive({ ...manifest, sha256: "0".repeat(64) });
      assert.throws(() => verifyEmbeddedIntegrationPackage(bytes, pluginBytes), /digest mismatch/u);
    });
    await t.test("unsupported schema, filename, digest format, and null descriptor fail", async () => {
      for (const descriptor of [null, { ...manifest, schemaVersion: 2 }, { ...manifest, file: "../plugin.tgz" },
        { ...manifest, sha256: sha256(pluginBytes) }, { ...manifest, sha256: "A".repeat(64) }, { ...manifest, sha256: 42 }]) {
        const bytes = await archive(descriptor);
        assert.throws(() => verifyEmbeddedIntegrationPackage(bytes, pluginBytes), /Invalid integration package manifest/u);
      }
    });
    await t.test("missing descriptor or archive fails", async () => {
      for (const filename of ["integration-package.json", "dsh-session-maintenance.tgz"]) {
        await archive();
        await rm(join(directory, filename));
        const bytes = await deterministicTarGz(root, "dsh-session-maintenance");
        assert.throws(() => verifyEmbeddedIntegrationPackage(bytes, pluginBytes), /Missing embedded integration package/u);
      }
    });
  } finally {
    assert.equal(dirname(fixture), artifacts);
    assert.ok(fixture.startsWith(join(artifacts, "synthetic-integration-package-")));
    await rm(fixture, { recursive: true, force: true });
  }
});
